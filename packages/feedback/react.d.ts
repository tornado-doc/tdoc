import type { TdocApi, TdocFeedbackOptions } from './index';
export interface TdocFeedbackProps extends TdocFeedbackOptions {
  onReady?: (api: TdocApi) => void;
}
export function TdocFeedback(props: TdocFeedbackProps): null;
export default TdocFeedback;
