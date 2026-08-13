export type UpdateState =
  | { status: 'idle' | 'checking' | 'latest' }
  | { status: 'available'; version: string; releaseNotes?: string }
  | { status: 'downloaded' | 'installing'; version: string }
  | { status: 'downloading'; percent: number }
  | { status: 'error'; message: string };
interface UpdateBridge {
  getState(): Promise<UpdateState>;
  check(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  install(): Promise<void>;
  onState(listener: (state: UpdateState) => void): () => void;
}
interface ExternalBridge {
  openSupportPage(): Promise<void>;
}
declare global { interface Window { twedelUpdates?: UpdateBridge; twedelExternal?: ExternalBridge } }
export const updates = typeof window === 'undefined' ? undefined : window.twedelUpdates;
