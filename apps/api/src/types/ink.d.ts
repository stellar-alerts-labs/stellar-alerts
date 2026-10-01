/**
 * Minimal ambient declarations for `ink`.
 *
 * `ink` 5 is ESM-only and publishes its types solely through the package
 * `exports` map, which the classic Node module resolution this project uses
 * cannot read — so `import ... from 'ink'` resolves at runtime but not for the
 * type-checker. This mirrors the existing `opossum` shim: declare the surface
 * the TUI actually uses, so a genuine incompatibility still surfaces as an
 * error at the call site rather than being silently ignored.
 *
 * The component props are intentionally loose (`[key: string]: unknown`).
 * `ink` accepts a large, style-driven prop set; enumerating it here would be a
 * copy that drifts, whereas the styling surface is checked at runtime by ink
 * itself.
 */
declare module 'ink' {
  import type { ComponentType, ReactElement } from 'react';

  type InkProps = Record<string, unknown> & { children?: unknown };

  export const Text: ComponentType<InkProps>;
  export const Box: ComponentType<InkProps>;
  export const Newline: ComponentType<InkProps>;
  export const Spacer: ComponentType<InkProps>;
  export const Static: ComponentType<InkProps>;
  export const useInput: (handler: (input: string, key: Record<string, boolean>) => void, options?: Record<string, unknown>) => void;
  export const useApp: () => { exit: () => void };
  export const useStdout: () => { write: (data: string) => void };
  export const useStderr: () => { write: (data: string) => void };
  export const render: (node: ReactElement, options?: Record<string, unknown>) => { unmount: () => void; waitUntilExit: () => Promise<void>; cleanup: () => void; rerender: (node: ReactElement) => void };
  export default render;
}
