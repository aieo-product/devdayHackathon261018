#pragma once

// Copy to config.h. Never commit config.h or put an OpenAI API key on the device.
namespace FocusConfig {
constexpr char WIFI_SSID[] = "REPLACE_WITH_WIFI_SSID";
constexpr char WIFI_PASSWORD[] = "REPLACE_WITH_WIFI_PASSWORD";
// Origin only, without /v1 or a trailing slash.
constexpr char API_BASE_URL[] = "https://REPLACE_WITH_API_HOST";
constexpr char FOCUS_API_TOKEN[] = "REPLACE_WITH_APP_TOKEN";
// PEM root CA that validates API_BASE_URL. Keep certificate validation enabled.
constexpr char ROOT_CA_PEM[] = R"PEM(-----BEGIN CERTIFICATE-----
REPLACE_WITH_API_ROOT_CA
-----END CERTIFICATE-----
)PEM";

// Development only: HTTP sends the image and app token without encryption.
// Enable only for a trusted local server on a private network.
constexpr bool ALLOW_LOCAL_HTTP = false;
constexpr unsigned long SESSION_DURATION_SECONDS = 1500;
constexpr bool ENABLE_BEEP = true;
}  // namespace FocusConfig
