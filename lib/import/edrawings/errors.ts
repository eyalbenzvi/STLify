/** Import failure with a Hebrew user-facing message. */
export class EDrawingsError extends Error {
  constructor(readonly messageHe: string) {
    super(messageHe);
    this.name = "EDrawingsError";
  }
}
