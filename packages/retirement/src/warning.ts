/**
 * A run warning as `SimOutput.warnings` carries it (seams §2.4, C41): a stable code and a plain
 * sentence for the owner. Engine warnings come first, then the tax area's `warningMessages(…)`.
 */
export interface EngineWarning {
  readonly code: string;
  readonly message: string;
}
