# Arrange your sidebars

Project, Git, Database and HTTP can each live on the left or right of the editor. One tool is visible per side. Click a tool tab to open it, switch to another tab on the same side, or click the active tab to hide it.

To put Git beside Project, drag the Git tab from the right rail onto the left rail. The left sidebar opens Git; click Project to return to the file tree. Both rails remain available even when all their tools have moved away.

You can also use the **⋯ Move** button in a panel header, right-click its tab, or focus the tab and press **Shift+F10**. Choose **Move to left sidebar** or **Move to right sidebar**. The **Arrange** button at the bottom of each rail provides the same controls. Drag the separator next to a panel to resize it; focused separators also accept the left and right arrow keys.

Each workspace saves tool positions and active panels in application settings. Existing workspaces keep Project on the left and migrate their previously open Git, Database or HTTP tool to the right. Moving the active tool opens it at its destination; Project reopens on the vacated side if it lives there, otherwise that side closes.

Moving a tool preserves its current state. Project filters and expanded folders and Git drafts also survive switching tabs or hiding their panels. Database and HTTP release their active tools when hidden. Pending database row edits require confirmation before another tool hides Database; moving Database itself does not discard edits. Terminal, Run and the other bottom tool windows remain in the bottom dock.

## Implementation and verification

`src/model/sidebar-layout.ts` owns the versioned layout, legacy migration and pure transitions. `SidebarRail` supplies validated local drag-and-drop and keyboard-accessible move controls. App renders stable keyed panel hosts and changes their visual order, avoiding remounts during a move. Layout writes are serialized and finish before switching workspaces.

Model and component tests cover malformed persisted data, external/malformed drops and accessible controls. App integration tests verify draft/editor ownership, saved placement and the pending database edit guard. `tests/e2e/sidebar-layout.mjs` exercises native menu workflows using disposable workspaces and real database/HTTP tools. The embedded driver emits synthetic mouse/key events; it cannot qualify physical dragging, Tab navigation or Shift+F10. Those require a separate trusted-input check rather than simulated drag events.
