export type FocusState = 'observing' | 'suspected' | 'cooldown' | 'paused' | 'ended' | 'unknown';
export interface FocusSnapshot {
  session_id: string;
  state: FocusState;
  notify: boolean;
  notification_id: string | null;
  message: string | null;
  phone_probability: number | null;
  observable_probability: number | null;
  consecutive_count: number;
  continuous_hold_ms: number;
  required_hold_ms: number;
  cooldown_remaining_ms: number;
  next_capture_after_ms: number;
  provider: 'openai' | 'mock';
  reason: string;
}
export class FocusApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string);
}
export class FocusClient {
  constructor(options: { baseUrl: string; token: string; fetchImpl?: typeof fetch });
  readonly active: boolean;
  readonly snapshot: FocusSnapshot | null;
  readonly remainingMs: number;
  start(options?: { deviceType?: string; durationSeconds?: number }): Promise<FocusSnapshot | null>;
  get(): Promise<FocusSnapshot | null>;
  frame(image: Blob | ArrayBuffer | ArrayBufferView, options?: { contentType?: 'image/jpeg' | 'image/png'; frameId?: string }): Promise<FocusSnapshot | null>;
  pause(): Promise<FocusSnapshot | null>;
  resume(): Promise<FocusSnapshot | null>;
  end(): Promise<FocusSnapshot | null>;
}
