#include <M5CoreS3.h>
#include <ArduinoJson.h>
#include <WiFi.h>
#include <NetworkClientSecure.h>
#include <HTTPClient.h>
#include <esp_camera.h>
#include <img_converters.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <cstdlib>
#include <cstring>
#include <time.h>

#if __has_include("config.h")
#include "config.h"
#else
#include "config.example.h"
#endif

// The server owns detection thresholds, consecutive counts, and cooldowns.
constexpr uint32_t WIFI_TIMEOUT_MS = 20000;
constexpr uint32_t CLOCK_TIMEOUT_MS = 10000;
constexpr uint32_t RETRY_DELAY_MS = 3000;
constexpr uint16_t HTTP_TIMEOUT_MS = 10000;
constexpr size_t MAX_RESPONSE_BYTES = 4096;

enum class Intent : uint8_t { Idle, Run, Pause, End };
struct Command {
  Intent intent;
  uint32_t generation;
  uint32_t endSequence;
};
struct UiEvent {
  uint32_t generation;
  char status[24];
  char detail[48];
  bool mock;
  bool notify;
};
struct Snapshot {
  String sessionId;
  String state;
  String notificationId;
  bool mock = false;
  bool notify = false;
  uint32_t nextCaptureMs = RETRY_DELAY_MS;
};

// HTTPClient decodes chunked transfer into this bounded sink as well as fixed bodies.
class ResponseBuffer : public Stream {
 public:
  String body;
  bool overflow = false;
  size_t write(uint8_t byte) override { return write(&byte, 1); }
  size_t write(const uint8_t* data, size_t size) override {
    if (body.length() + size > MAX_RESPONSE_BYTES ||
        !body.concat(reinterpret_cast<const char*>(data), size)) {
      overflow = true;
      return 0;
    }
    return size;
  }
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}
};

portMUX_TYPE commandLock = portMUX_INITIALIZER_UNLOCKED;
Command requested{Intent::Idle, 0, 0};
QueueHandle_t uiQueue = nullptr;
SemaphoreHandle_t hardwareLock = nullptr;
bool configured = false;
bool workerReady = false;

Command readCommand() {
  portENTER_CRITICAL(&commandLock);
  Command result = requested;
  portEXIT_CRITICAL(&commandLock);
  return result;
}

Command changeIntent(Intent intent) {
  portENTER_CRITICAL(&commandLock);
  requested.intent = intent;
  ++requested.generation;
  if (intent == Intent::End) ++requested.endSequence;
  Command result = requested;
  portEXIT_CRITICAL(&commandLock);
  return result;
}

bool isCurrent(const Command& command) {
  Command current = readCommand();
  return current.generation == command.generation && current.intent == command.intent;
}

void finishLocally(const Command& command) {
  portENTER_CRITICAL(&commandLock);
  if (requested.generation == command.generation) requested.intent = Intent::Idle;
  portEXIT_CRITICAL(&commandLock);
}

void publish(const Command& command, const char* status, const char* detail = "",
             bool mock = false, bool notify = false) {
  UiEvent event{};
  event.generation = command.generation;
  snprintf(event.status, sizeof(event.status), "%s", status);
  snprintf(event.detail, sizeof(event.detail), "%s", detail);
  event.mock = mock;
  event.notify = notify;
  xQueueOverwrite(uiQueue, &event);
}

bool placeholder(const char* value) {
  return value[0] == '\0' || strstr(value, "REPLACE_WITH") != nullptr;
}

bool localHttpUrl(const String& url) {
  if (!url.startsWith("http://")) return false;
  String host = url.substring(7);
  int end = host.indexOf('/');
  if (end >= 0) host = host.substring(0, end);
  end = host.indexOf(':');
  if (end >= 0) host = host.substring(0, end);
  if (host == "localhost" || host.endsWith(".local")) return true;
  IPAddress ip;
  if (!ip.fromString(host)) return false;
  return ip[0] == 10 || ip[0] == 127 ||
         (ip[0] == 192 && ip[1] == 168) ||
         (ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31);
}

bool configurationValid() {
  if (placeholder(FocusConfig::WIFI_SSID) ||
      placeholder(FocusConfig::FOCUS_API_TOKEN)) return false;
  String base(FocusConfig::API_BASE_URL);
  if (placeholder(FocusConfig::API_BASE_URL) || base.endsWith("/") ||
      base.indexOf('@') >= 0 || base.indexOf('?') >= 0 || base.indexOf('#') >= 0) return false;
  if (base.startsWith("https://")) return !placeholder(FocusConfig::ROOT_CA_PEM);
  return FocusConfig::ALLOW_LOCAL_HTTP && localHttpUrl(base);
}

bool ensureNetwork(const Command& command) {
  if (WiFi.status() != WL_CONNECTED) {
    publish(command, "CONNECTING", "Connecting Wi-Fi");
    WiFi.mode(WIFI_STA);
    WiFi.begin(FocusConfig::WIFI_SSID, FocusConfig::WIFI_PASSWORD);
    uint32_t started = millis();
    while (WiFi.status() != WL_CONNECTED) {
      if (!isCurrent(command)) return false;
      if (millis() - started >= WIFI_TIMEOUT_MS) {
        publish(command, "UNKNOWN", "Wi-Fi timeout; press START");
        return false;
      }
      vTaskDelay(pdMS_TO_TICKS(50));
    }
  }
  if (String(FocusConfig::API_BASE_URL).startsWith("https://") &&
      time(nullptr) < 1704067200) {
    publish(command, "CONNECTING", "Synchronizing clock");
    configTime(0, 0, "pool.ntp.org", "time.cloudflare.com");
    uint32_t started = millis();
    while (time(nullptr) < 1704067200) {
      if (!isCurrent(command)) return false;
      if (millis() - started >= CLOCK_TIMEOUT_MS) {
        publish(command, "UNKNOWN", "Clock timeout; press START");
        return false;
      }
      vTaskDelay(pdMS_TO_TICKS(50));
    }
  }
  return isCurrent(command);
}

bool validSessionId(const String& id) {
  if (id.isEmpty() || id.length() > 128) return false;
  for (size_t i = 0; i < id.length(); ++i) {
    char c = id[i];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') || c == '-' || c == '_')) return false;
  }
  return true;
}

bool parseSnapshot(const String& body, Snapshot& result) {
  JsonDocument doc;  // ArduinoJson 7
  if (deserializeJson(doc, body, DeserializationOption::NestingLimit(6))) return false;
  if (!doc["session_id"].is<const char*>() || !doc["state"].is<const char*>() ||
      !doc["provider"].is<const char*>() || !doc["notify"].is<bool>() ||
      !doc["next_capture_after_ms"].is<uint32_t>()) return false;
  result.sessionId = doc["session_id"].as<const char*>();
  result.state = doc["state"].as<const char*>();
  String provider = doc["provider"].as<const char*>();
  if (!validSessionId(result.sessionId) ||
      !(provider == "openai" || provider == "mock") ||
      !(result.state == "observing" || result.state == "suspected" ||
        result.state == "cooldown" || result.state == "paused" ||
        result.state == "ended" || result.state == "unknown")) return false;
  result.mock = provider == "mock";
  result.notify = doc["notify"].as<bool>();
  result.notificationId = doc["notification_id"] | "";
  result.nextCaptureMs = doc["next_capture_after_ms"].as<uint32_t>();
  // millis() comparisons require a delay below half its uint32_t range.
  if (result.nextCaptureMs > 86400000UL) return false;
  return !result.notify || !result.notificationId.isEmpty();
}

// Calls only run on the worker. A STOP can invalidate the response while HTTP waits.
bool request(const Command& command, const String& path, const char* contentType,
             uint8_t* bytes, size_t length, int expectedStatus, Snapshot& snapshot,
             String& error, const String& frameId = "") {
  if (!isCurrent(command)) return false;
  if (WiFi.status() != WL_CONNECTED) {
    error = "Wi-Fi disconnected";
    return false;
  }
  NetworkClientSecure secure;
  NetworkClient plain;
  HTTPClient http;
  String url = String(FocusConfig::API_BASE_URL) + path;
  bool began = false;
  if (url.startsWith("https://")) {
    secure.setCACert(FocusConfig::ROOT_CA_PEM);
    secure.setHandshakeTimeout(10);
    began = http.begin(secure, url);
  } else if (FocusConfig::ALLOW_LOCAL_HTTP && localHttpUrl(url)) {
    began = http.begin(plain, url);
  }
  if (!began) {
    error = "URL / TLS setup failed";
    return false;
  }
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  http.addHeader("Authorization", String("Bearer ") + FocusConfig::FOCUS_API_TOKEN);
  http.addHeader("Content-Type", contentType);
  http.addHeader("Accept", "application/json");
  if (!frameId.isEmpty()) http.addHeader("X-Frame-Id", frameId);
  if (!isCurrent(command)) {
    http.end();
    return false;
  }
  int code = http.POST(bytes, length);
  if (code != expectedStatus) {
    error = code < 0 ? "Network / TLS request failed" : String("HTTP ") + code;
    http.end();
    return false;
  }
  // Bound both fixed-length and chunked JSON responses.
  int responseSize = http.getSize();
  if (responseSize > static_cast<int>(MAX_RESPONSE_BYTES)) {
    error = "Unexpected response length";
    http.end();
    return false;
  }
  ResponseBuffer response;
  int received = http.writeToStream(&response);
  http.end();
  if (received <= 0 || response.overflow || !parseSnapshot(response.body, snapshot)) {
    error = "Invalid API snapshot";
    return false;
  }
  return true;
}

bool postJson(const Command& command, const String& path, JsonDocument& doc,
              int status, Snapshot& snapshot, String& error) {
  String body;
  serializeJson(doc, body);
  return request(command, path, "application/json",
                 reinterpret_cast<uint8_t*>(const_cast<char*>(body.c_str())),
                 body.length(), status, snapshot, error);
}

bool controlSession(const Command& command, const String& id, const char* action,
                    Snapshot& snapshot, String& error) {
  JsonDocument doc;
  doc["action"] = action;
  bool ok = postJson(command, "/v1/sessions/" + id + "/control", doc, 200, snapshot, error);
  if (ok && snapshot.sessionId != id) {
    error = "Session mismatch";
    return false;
  }
  return ok;
}

bool captureJpeg(const Command& command, uint8_t** jpeg, size_t* length, String& error) {
  if (!isCurrent(command)) return false;
  // Serialize M5's I2C setup/teardown with touch handling. No lock is held during HTTP.
  xSemaphoreTake(hardwareLock, portMAX_DELAY);
  bool started = isCurrent(command) && CoreS3.Camera.begin();
  if (!started) {
    xSemaphoreGive(hardwareLock);
    error = "Camera initialization failed";
    return false;
  }
  bool acquired = isCurrent(command) && CoreS3.Camera.get();
  bool converted = acquired && frame2jpg(CoreS3.Camera.fb, 80, jpeg, length);
  if (acquired) {
    CoreS3.Camera.free();
    CoreS3.Camera.fb = nullptr; // The v1.0.1 wrapper does not clear this pointer.
  }
  // Each request is a snapshot. Release the camera before waiting for the server.
  esp_camera_deinit();
  xSemaphoreGive(hardwareLock);
  if (!converted) error = acquired ? "JPEG conversion failed" : "Camera capture failed";
  return converted;
}

void showSnapshot(const Command& command, const Snapshot& snapshot, String& lastNotification) {
  if (!isCurrent(command)) return;
  if (snapshot.state == "ended") {
    finishLocally(command);
    publish(command, "ENDED", "Press START for a new session", snapshot.mock);
    return;
  }
  bool alert = command.intent == Intent::Run && snapshot.notify &&
               snapshot.state != "paused" && snapshot.state != "unknown" &&
               snapshot.notificationId != lastNotification;
  if (alert) lastNotification = snapshot.notificationId;
  const char* status = "UNKNOWN";
  if (alert) status = "PUT PHONE DOWN";
  else if (snapshot.state == "observing") status = "FOCUS";
  else if (snapshot.state == "suspected") status = "CHECKING";
  else if (snapshot.state == "cooldown") status = "COOLDOWN";
  else if (snapshot.state == "paused") status = "PAUSED";
  publish(command, status, snapshot.mock ? "Simulated judgment" : "Server judgment",
          snapshot.mock, alert);
}

void worker(void*) {
  String sessionId;
  String lastNotification;
  bool serverPaused = true;
  bool serverEnded = false;
  uint32_t handledGeneration = UINT32_MAX;
  uint32_t sequence = 0;
  uint32_t nextCaptureAt = 0;
  uint32_t completedEndSequence = 0;
  bool runReady = false;
  for (;;) {
    Command command = readCommand();
    if (command.intent == Intent::Idle) {
      vTaskDelay(pdMS_TO_TICKS(25));
      continue;
    }
    // END is latched: END -> START during an HTTP request must retire the old
    // session before START is allowed to create a fresh one.
    if (command.endSequence != completedEndSequence) {
      runReady = false;
      if (!sessionId.isEmpty() && !serverEnded) {
        if (!ensureNetwork(command)) {
          vTaskDelay(pdMS_TO_TICKS(100));
          continue;
        }
        Snapshot ended;
        String error;
        if (!controlSession(command, sessionId, "end", ended, error) || ended.state != "ended") {
          if (isCurrent(command))
            publish(command, command.intent == Intent::Run ? "UNKNOWN" : "ENDED",
                    "End pending; retrying server");
          // No frames while END is pending. UI remains responsive during this wait.
          for (uint32_t waited = 0; waited < RETRY_DELAY_MS && isCurrent(command); waited += 50)
            vTaskDelay(pdMS_TO_TICKS(50));
          continue;
        }
        serverEnded = true;
      }
      completedEndSequence = command.endSequence;
      if (!isCurrent(command)) continue;
    }
    if (command.generation != handledGeneration) {
      handledGeneration = command.generation;
      runReady = false;
      String error;
      Snapshot snapshot;
      if (!ensureNetwork(command)) continue;
      bool ok = true;
      if (command.intent == Intent::Run) {
        if (sessionId.isEmpty() || serverEnded) {
          JsonDocument doc;
          doc["device_type"] = "cores3";
          doc["duration_seconds"] = FocusConfig::SESSION_DURATION_SECONDS;
          ok = postJson(command, "/v1/sessions", doc, 201, snapshot, error);
          if (ok) {
            // Retain even a stale creation result so the pending STOP can pause it.
            sessionId = snapshot.sessionId;
            sequence = 0;
            lastNotification = "";
          }
        } else {
          ok = controlSession(command, sessionId, "resume", snapshot, error);
        }
      } else if (!sessionId.isEmpty() && !serverEnded) {
        ok = controlSession(command, sessionId,
                            command.intent == Intent::Pause ? "pause" : "end",
                            snapshot, error);
      } else {
        publish(command, command.intent == Intent::Pause ? "PAUSED" : "ENDED",
                "No active server session");
        continue;
      }
      if (!ok) {
        if (isCurrent(command)) {
          const char* status = command.intent == Intent::Pause ? "PAUSED" :
                               command.intent == Intent::End ? "ENDED" : "UNKNOWN";
          publish(command, status, error.isEmpty() ? "Press START to retry" : error.c_str());
        }
        continue;
      }
      serverPaused = snapshot.state == "paused";
      serverEnded = snapshot.state == "ended";
      if (command.intent == Intent::End && !serverEnded) {
        publish(command, "ENDED", "Server end was not confirmed", snapshot.mock);
        continue;
      }
      showSnapshot(command, snapshot, lastNotification);
      runReady = command.intent == Intent::Run && !serverPaused && !serverEnded;
      nextCaptureAt = millis() + snapshot.nextCaptureMs;
    }
    if (command.intent != Intent::Run || !runReady || !isCurrent(command) ||
        static_cast<int32_t>(millis() - nextCaptureAt) < 0) {
      vTaskDelay(pdMS_TO_TICKS(25));
      continue;
    }

    if (!ensureNetwork(command)) {
      nextCaptureAt = millis() + RETRY_DELAY_MS;
      continue;
    }
    uint8_t* jpeg = nullptr;
    size_t jpegLength = 0;
    String error;
    Snapshot snapshot;
    bool ok = captureJpeg(command, &jpeg, &jpegLength, error);
    if (ok && isCurrent(command)) {
      String frameId = String(++sequence);
      ok = request(command, "/v1/sessions/" + sessionId + "/frames", "image/jpeg",
                   jpeg, jpegLength, 200, snapshot, error, frameId);
      if (ok && snapshot.sessionId != sessionId) {
        ok = false;
        error = "Session mismatch";
      }
    }
    free(jpeg);
    if (!isCurrent(command)) continue; // STOP invalidates in-flight results and beeps.
    if (!ok) {
      publish(command, "UNKNOWN", error.c_str());
      nextCaptureAt = millis() + RETRY_DELAY_MS;
      continue;
    }
    serverPaused = snapshot.state == "paused";
    serverEnded = snapshot.state == "ended";
    runReady = !serverPaused && !serverEnded;
    showSnapshot(command, snapshot, lastNotification);
    nextCaptureAt = millis() + snapshot.nextCaptureMs;
  }
}

void drawStatus(const char* status, const char* detail, bool mock = false) {
  CoreS3.Display.fillScreen(TFT_BLACK);
  CoreS3.Display.setTextColor(TFT_WHITE, TFT_BLACK);
  CoreS3.Display.setTextSize(2);
  CoreS3.Display.setCursor(12, 12);
  CoreS3.Display.print("FOCUS / CoreS3");
  CoreS3.Display.setTextColor(mock ? TFT_YELLOW : TFT_CYAN, TFT_BLACK);
  CoreS3.Display.setTextSize(1);
  CoreS3.Display.setCursor(12, 40);
  CoreS3.Display.print(mock ? "MOCK - simulated result" : "Independent camera client");
  CoreS3.Display.setTextColor(TFT_WHITE, TFT_BLACK);
  CoreS3.Display.setTextSize(2);
  CoreS3.Display.setCursor(12, 78);
  CoreS3.Display.print(status);
  CoreS3.Display.setTextSize(1);
  CoreS3.Display.setCursor(12, 118);
  CoreS3.Display.print(detail);
  CoreS3.Display.setCursor(12, 146);
  CoreS3.Display.print("STOP pauses locally; END finishes.");
  const char* labels[] = {"START", "STOP", "END"};
  for (int i = 0; i < 3; ++i) {
    int x = 6 + i * 106;
    CoreS3.Display.drawRoundRect(x, 182, 100, 50, 5, TFT_WHITE);
    CoreS3.Display.setTextSize(2);
    CoreS3.Display.setCursor(x + 14, 199);
    CoreS3.Display.print(labels[i]);
  }
}

void setup() {
  CoreS3.begin(M5.config());
  CoreS3.Display.setRotation(1);
  CoreS3.Display.setTextWrap(false);
  CoreS3.Speaker.setVolume(70);
  uiQueue = xQueueCreate(1, sizeof(UiEvent));
  hardwareLock = xSemaphoreCreateMutex();
  configured = configurationValid();
  if (!uiQueue || !hardwareLock) {
    drawStatus("UNKNOWN", "Cannot allocate worker resources");
    return;
  }
  workerReady = xTaskCreate(worker, "focus-network", 16384, nullptr, 1, nullptr) == pdPASS;
  drawStatus(!workerReady ? "UNKNOWN" : configured ? "PAUSED" : "CONFIG REQUIRED",
             !workerReady ? "Worker creation failed" :
             configured ? "Press START to allow image upload" : "Copy config.example.h to config.h");
}

void loop() {
  // Hardware access is brief except during a single camera snapshot/encoding.
  if (hardwareLock && xSemaphoreTake(hardwareLock, 0) == pdTRUE) {
    CoreS3.update();
    if (configured && workerReady && CoreS3.Touch.getCount() > 0) {
      auto touch = CoreS3.Touch.getDetail();
      if (touch.wasPressed() && touch.y >= 182 && touch.y <= 232) {
        if (touch.x >= 6 && touch.x <= 106) {
          changeIntent(Intent::Run);
          drawStatus("STARTING", "Waiting for server");
        } else if (touch.x >= 112 && touch.x <= 212) {
          changeIntent(Intent::Pause);
          drawStatus("PAUSED", "Stopped locally; syncing server");
        } else if (touch.x >= 218 && touch.x <= 318) {
          changeIntent(Intent::End);
          drawStatus("ENDED", "Stopped locally; syncing server");
        }
      }
    }
    UiEvent event{};
    if (uiQueue && xQueueReceive(uiQueue, &event, 0) == pdTRUE &&
        event.generation == readCommand().generation) {
      drawStatus(event.status, event.detail, event.mock);
      if (event.notify && readCommand().intent == Intent::Run && FocusConfig::ENABLE_BEEP)
        CoreS3.Speaker.tone(880, 120);
    }
    xSemaphoreGive(hardwareLock);
  }
  delay(15);
}
