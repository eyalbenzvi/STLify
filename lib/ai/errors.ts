/**
 * Error type shared by the AI paths (on-device and cloud alike).
 *
 * Follows the importer convention: the constructor takes the Hebrew message,
 * passes it to super() AND exposes it as `messageHe`, so both the generic
 * fallback and the explicit unwrap in useEditorOps print Hebrew.
 */

export class AiError extends Error {
  constructor(readonly messageHe: string) {
    super(messageHe);
    this.name = "AiError";
  }
}
