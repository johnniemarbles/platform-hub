/**
 * Signature Version 4 lives in @platform-hub/aws-sigv4.
 *
 * It was a stub here — it returned a fixed, meaningless Authorization header,
 * which means the SES probe has never been able to validate a credential: AWS
 * answered 403 and the probe reported every working key as invalid. The real
 * implementation is shared rather than reproduced because the content asset
 * store needs it too.
 */
export { sigV4Headers, type SigV4Options } from '@platform-hub/aws-sigv4';
