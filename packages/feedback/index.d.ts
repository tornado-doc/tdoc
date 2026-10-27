export interface TdocApi {
  /** Show the comment layer. */
  open(): void;
  /** Hide it (remembered across reloads until opened again). */
  close(): void;
  hide(): void;
  toggle(): void;
  /** Start picking an element to comment on. */
  comment(): void;
  /** Forget this browser's sign-in for the site. */
  disconnect(): void;
  /** Listen for 'open' | 'close' | 'comment'. Returns an unsubscribe. */
  on(event: 'open' | 'close' | 'comment', fn: (detail?: { id?: string; text?: string; parentId?: string }) => void): () => void;
  base: string;
  space: string | null;
}
export interface TdocFeedbackOptions {
  /** The space id from tdoc: My docs → Feedback → Add to your site. */
  space: string;
  /** tdoc host. Default https://tdoc.dev */
  base?: string;
  /** Open the comment layer as soon as it loads. */
  open?: boolean;
}
export function loadTdocFeedback(options: TdocFeedbackOptions): Promise<TdocApi>;
export default loadTdocFeedback;
