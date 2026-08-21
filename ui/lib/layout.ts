/** Geometry shared between tabs, where two panes have to agree.
 *
 * Library's inspector and Convert's settings column are the same pane in two
 * tabs as far as the eye is concerned: same edge, same border, same kind of
 * form inside. Switching tabs must not move that edge, so both start here.
 * Library's may then be dragged — it is the one with a resize handle — but it
 * cannot go below this, or the two would stop lining up at their narrowest. */
export const SIDE_PANEL_WIDTH = 320;

/** How wide Library's inspector may be dragged. Past this the track list is
 * the thing being squeezed, and the list is what the window is for. */
export const SIDE_PANEL_MAX_WIDTH = 720;
