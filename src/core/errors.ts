export class CoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreError';
  }
}

export function safeError(error: unknown): string {
  return error instanceof CoreError ? error.message : '操作失败，请稍后重试。';
}
