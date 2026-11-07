/**
 * Browser half of dsh-image-bridge.
 *
 * The bridge's work is entirely Host-side (it starts a vision subagent when the
 * model calls the tool), so the web GUI needs no custom surface: tool calls and
 * their results render through the generic conversation cards. This module
 * exists so the package declares a client platform and stays loadable if a
 * future version adds a panel; it registers nothing yet.
 *
 * Emitted in the built module-loader bundle form (not bare ESM): the browser
 * serves this file as a classic script in the boot combo, where a top-level
 * `export` is a syntax error ("Unexpected token 'export'").
 *
 * @module dsh-image-bridge/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-image-bridge',
  factory() {
    return {
      name: 'vision-bridge-client',
      apply() {
        // No client-side registrations: image reading is a Host capability.
      },
    };
  },
});
