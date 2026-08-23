// Module augmentation registering this app's router type with TanStack
// Router, so `Link`/`useNavigate` get typed routes app-wide.
//
// This lives in a .d.ts rather than beside the router because `declare
// module` is type-only syntax with no JSDoc equivalent — the one construct
// in this codebase that genuinely cannot be expressed in a .js file.
//
// The bare import matters: without a top-level import or export this file
// would be a global script, and `declare module` would then shadow the real
// package rather than augment it.
import "@tanstack/react-router";

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof import("./router.jsx").router;
  }
}
