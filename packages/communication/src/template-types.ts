export type CommunicationTemplateMatchedScope =
  | 'ORGANIZATION'
  | 'TENANT'
  | 'PLATFORM'
  | 'NONE';

export interface RenderedCommunicationTemplate {
  readonly templateId: string;
  readonly version: number;
  readonly channel: string;
  readonly locale: string;
  readonly format: string;
  readonly subject?: string;
  readonly title?: string;
  readonly body: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly contentPolicyViolations?: readonly unknown[];
}
