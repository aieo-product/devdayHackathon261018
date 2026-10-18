import { randomUUID } from 'node:crypto';
import { HttpError, DecisionError } from './errors.mjs';

export const DEFAULT_SETTINGS = Object.freeze({
  captureIntervalMs: 3000,
  phoneThreshold: 0.8,
  observableThreshold: 0.7,
  requiredConsecutive: 3,
  cooldownMs: 60_000,
  maxSampleGapMs: 10_000,
  decisionTimeoutMs: 10_000,
  maxResultAgeMs: 10_000,
  retentionMs: 30 * 60_000,
  maxSessions: 1000,
  maxFramesPerSession: 10_000,
});

const activeStates = new Set(['observing', 'suspected', 'cooldown', 'unknown']);
const probability = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

export class FocusEngine {
  constructor({ provider, clock = Date.now, settings = {} }) {
    this.provider = provider;
    this.clock = clock;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.sessions = new Map();
  }

  cleanup() {
    const now = this.clock();
    for (const [id, session] of this.sessions) {
      this.refresh(session);
      if (session.endedAt !== null && now - session.endedAt > this.settings.retentionMs) {
        session.inFlight?.controller.abort();
        this.sessions.delete(id);
      }
    }
  }

  create({ owner, deviceType, durationSeconds = 1500 }) {
    this.cleanup();
    if (this.sessions.size >= this.settings.maxSessions) {
      throw new HttpError(429, 'session_limit', 'セッション数の上限です。時間をおいて再試行してください。');
    }
    const now = this.clock();
    const session = {
      id: randomUUID(), owner, deviceType, state: 'observing',
      createdAt: now, expiresAt: now + durationSeconds * 1000, endedAt: null,
      generation: 0, inFlight: null, seenFrames: new Set(),
      phoneProbability: null, observableProbability: null,
      count: 0, cooldownUntil: 0, lastAcceptedAt: null, lastSampleAt: null,
      reason: 'session_started',
    };
    this.sessions.set(session.id, session);
    return this.snapshot(session);
  }

  find(owner, id) {
    this.cleanup();
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) {
      throw new HttpError(404, 'session_not_found', 'セッションが見つかりません。');
    }
    this.refresh(session);
    return session;
  }

  refresh(session) {
    const now = this.clock();
    if (session.state !== 'ended' && now >= session.expiresAt) {
      this.invalidate(session);
      session.state = 'ended';
      session.endedAt = session.expiresAt;
      session.reason = 'session_expired';
    } else if (session.state === 'cooldown' && now >= session.cooldownUntil) {
      session.state = 'observing';
      session.count = 0;
      session.lastSampleAt = null;
      session.reason = 'cooldown_finished';
    }
  }

  invalidate(session) {
    session.generation += 1;
    session.count = 0;
    session.lastSampleAt = null;
    session.phoneProbability = null;
    session.observableProbability = null;
    session.inFlight?.controller.abort();
    session.inFlight = null;
  }

  snapshot(session, extra = {}) {
    this.refresh(session);
    const active = activeStates.has(session.state);
    const cooldownRemaining = Math.max(0, session.cooldownUntil - this.clock());
    const captureRemaining = session.lastAcceptedAt === null ? 0 : Math.max(0, this.settings.captureIntervalMs - (this.clock() - session.lastAcceptedAt));
    const result = {
      session_id: session.id,
      state: session.state,
      notify: false,
      notification_id: null,
      message: null,
      phone_probability: session.phoneProbability,
      observable_probability: session.observableProbability,
      consecutive_count: session.count,
      cooldown_remaining_ms: session.state === 'ended' ? 0 : cooldownRemaining,
      next_capture_after_ms: active ? Math.max(captureRemaining, cooldownRemaining) : 0,
      provider: this.provider.name,
      reason: session.reason,
      ...extra,
    };
    if (!active) {
      result.notify = false;
      result.notification_id = null;
      result.message = null;
    }
    return result;
  }

  get({ owner, sessionId }) {
    return this.snapshot(this.find(owner, sessionId));
  }

  getGeneration({ owner, sessionId }) {
    return this.find(owner, sessionId).generation;
  }

  control({ owner, sessionId, action }) {
    const session = this.find(owner, sessionId);
    if (session.state === 'ended') return this.snapshot(session);
    if (action === 'end') {
      this.invalidate(session);
      session.state = 'ended';
      session.cooldownUntil = 0;
      session.endedAt = this.clock();
      session.reason = 'session_ended';
    } else if (action === 'pause' && session.state !== 'paused') {
      this.invalidate(session);
      session.state = 'paused';
      session.reason = 'session_paused';
    } else if (action === 'resume' && session.state === 'paused') {
      this.invalidate(session);
      session.state = this.clock() < session.cooldownUntil ? 'cooldown' : 'observing';
      session.reason = 'session_resumed';
    }
    return this.snapshot(session);
  }

  async frame({ owner, sessionId, frameId, bytes, contentType, expectedGeneration }) {
    const session = this.find(owner, sessionId);
    if (expectedGeneration !== undefined && expectedGeneration !== session.generation) {
      return this.snapshot(session, { reason: 'session_changed' });
    }
    if (!activeStates.has(session.state)) {
      return this.snapshot(session, { reason: session.state === 'paused' ? 'session_paused' : session.reason });
    }
    if (session.seenFrames.has(frameId)) return this.snapshot(session, { reason: 'duplicate_frame' });
    if (session.inFlight) throw new HttpError(409, 'frame_in_progress', '前の画像を判定中です。');
    if (session.seenFrames.size >= this.settings.maxFramesPerSession) {
      throw new HttpError(429, 'frame_limit', 'このセッションの画像数上限です。セッションを終了してください。');
    }
    session.seenFrames.add(frameId);
    if (session.state === 'cooldown') return this.snapshot(session, { reason: 'cooldown_active' });
    const now = this.clock();
    if (session.lastAcceptedAt !== null && now - session.lastAcceptedAt < this.settings.captureIntervalMs) {
      return this.snapshot(session, { reason: 'capture_too_soon' });
    }
    session.lastAcceptedAt = now;
    if (session.lastSampleAt === null || now - session.lastSampleAt > this.settings.maxSampleGapMs) session.count = 0;
    const flight = { controller: new AbortController(), generation: session.generation };
    session.inFlight = flight;
    let timer;
    let onAbort;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new DecisionError('decision_timeout'));
          flight.controller.abort();
        }, this.settings.decisionTimeoutMs);
      });
      const cancelled = new Promise((_, reject) => {
        onAbort = () => reject(new DecisionError('decision_cancelled'));
        flight.controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      const result = await Promise.race([
        Promise.resolve().then(() => this.provider.decide({ bytes, contentType, signal: flight.controller.signal })),
        timeout, cancelled,
      ]);
      this.refresh(session);
      if (session.generation !== flight.generation || !activeStates.has(session.state)) {
        return this.snapshot(session, { reason: 'session_changed' });
      }
      if (this.clock() - now > this.settings.maxResultAgeMs) throw new DecisionError('stale_result');
      if (!probability(result.phoneProbability) || !probability(result.observableProbability)) {
        throw new DecisionError('invalid_decision');
      }
      session.phoneProbability = result.phoneProbability;
      session.observableProbability = result.observableProbability;
      session.lastSampleAt = now;
      if (result.observableProbability < this.settings.observableThreshold) {
        session.count = 0;
        session.state = 'unknown';
        session.reason = 'insufficient_visibility';
      } else if (result.phoneProbability >= this.settings.phoneThreshold) {
        session.count += 1;
        if (session.count >= this.settings.requiredConsecutive) {
          session.state = 'cooldown';
          session.cooldownUntil = this.clock() + this.settings.cooldownMs;
          session.count = 0;
          session.reason = 'phone_use_confirmed';
          return this.snapshot(session, {
            notify: true, notification_id: randomUUID(), message: 'スマホを置いて、作業に戻りませんか？',
          });
        }
        session.state = 'suspected';
        session.reason = 'phone_use_suspected';
      } else {
        session.count = 0;
        session.state = 'observing';
        session.reason = 'phone_use_not_detected';
      }
      return this.snapshot(session);
    } catch (error) {
      this.refresh(session);
      if (session.generation !== flight.generation || !activeStates.has(session.state)) {
        return this.snapshot(session, { reason: 'session_changed' });
      }
      session.state = 'unknown';
      session.count = 0;
      session.lastSampleAt = null;
      session.phoneProbability = null;
      session.observableProbability = null;
      const safeCodes = new Set(['decision_timeout', 'decision_refused', 'stale_result', 'invalid_decision', 'provider_not_configured']);
      session.reason = safeCodes.has(error?.code) ? error.code : 'provider_error';
      return this.snapshot(session);
    } finally {
      clearTimeout(timer);
      flight.controller.signal.removeEventListener('abort', onAbort);
      if (session.inFlight === flight) session.inFlight = null;
    }
  }
}
