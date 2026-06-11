/**
 * Typed event handlers for HTML intrinsic elements. Mirrors the common
 * `on*` properties DOM elements expose, with the right event type per
 * handler. Used by `h()`'s `_props` parameter (`IntrinsicProps`) so that
 *
 *   <button onclick={(e) => …}>   // e: MouseEvent
 *   <form onsubmit={(e) => …}>    // e: SubmitEvent
 *   <input oninput={(e) => …}>    // e: Event
 *
 * Intersected with `Record<string, unknown>` so arbitrary HTML
 * attributes (`data-*`, `aria-*`, custom) still pass through unchecked.
 * Tag-specific narrowing of `e.target` is a future improvement.
 *
 * The `unknown` return is the honest runtime contract (`applyProp` in
 * `mount.ts`): a returned `Effect` is run on the mount-captured context —
 * its failure routes to the nearest boundary sink — and any other return
 * value is ignored. The handler's `E`/`R` are not read from this constraint;
 * `h()` infers the actual props type and folds them via
 * `FoldPropsLiveE`/`FoldPropsR` (see `Fold.ts`): `E` onto the element's
 * live channel (`View<E>`), `R` into the element's requirements.
 */

type EventHandler<E extends Event> = (event: E) => unknown

export interface HtmlEventHandlers {
  // Pointer / mouse
  readonly onclick?: EventHandler<MouseEvent>
  readonly ondblclick?: EventHandler<MouseEvent>
  readonly onmousedown?: EventHandler<MouseEvent>
  readonly onmouseup?: EventHandler<MouseEvent>
  readonly onmouseover?: EventHandler<MouseEvent>
  readonly onmouseout?: EventHandler<MouseEvent>
  readonly onmouseenter?: EventHandler<MouseEvent>
  readonly onmouseleave?: EventHandler<MouseEvent>
  readonly onmousemove?: EventHandler<MouseEvent>
  readonly oncontextmenu?: EventHandler<MouseEvent>
  readonly onwheel?: EventHandler<WheelEvent>

  // Pointer events (broader than mouse — covers touch + pen)
  readonly onpointerdown?: EventHandler<PointerEvent>
  readonly onpointerup?: EventHandler<PointerEvent>
  readonly onpointermove?: EventHandler<PointerEvent>
  readonly onpointerover?: EventHandler<PointerEvent>
  readonly onpointerout?: EventHandler<PointerEvent>
  readonly onpointerenter?: EventHandler<PointerEvent>
  readonly onpointerleave?: EventHandler<PointerEvent>
  readonly onpointercancel?: EventHandler<PointerEvent>

  // Keyboard
  readonly onkeydown?: EventHandler<KeyboardEvent>
  readonly onkeyup?: EventHandler<KeyboardEvent>
  readonly onkeypress?: EventHandler<KeyboardEvent>

  // Focus
  readonly onfocus?: EventHandler<FocusEvent>
  readonly onblur?: EventHandler<FocusEvent>
  readonly onfocusin?: EventHandler<FocusEvent>
  readonly onfocusout?: EventHandler<FocusEvent>

  // Form
  readonly onsubmit?: EventHandler<SubmitEvent>
  readonly onreset?: EventHandler<Event>
  readonly oninvalid?: EventHandler<Event>
  readonly onchange?: EventHandler<Event>
  readonly oninput?: EventHandler<Event>
  readonly onselect?: EventHandler<Event>

  // Lifecycle / media / loading
  readonly onload?: EventHandler<Event>
  readonly onerror?: EventHandler<Event>
  readonly onscroll?: EventHandler<Event>
  readonly onresize?: EventHandler<UIEvent>
  readonly onabort?: EventHandler<Event>

  // Clipboard
  readonly oncopy?: EventHandler<ClipboardEvent>
  readonly oncut?: EventHandler<ClipboardEvent>
  readonly onpaste?: EventHandler<ClipboardEvent>

  // Drag & drop
  readonly ondragstart?: EventHandler<DragEvent>
  readonly ondrag?: EventHandler<DragEvent>
  readonly ondragend?: EventHandler<DragEvent>
  readonly ondragenter?: EventHandler<DragEvent>
  readonly ondragleave?: EventHandler<DragEvent>
  readonly ondragover?: EventHandler<DragEvent>
  readonly ondrop?: EventHandler<DragEvent>

  // Touch
  readonly ontouchstart?: EventHandler<TouchEvent>
  readonly ontouchmove?: EventHandler<TouchEvent>
  readonly ontouchend?: EventHandler<TouchEvent>
  readonly ontouchcancel?: EventHandler<TouchEvent>
}

/**
 * The props type assigned to every HTML intrinsic tag (`<div>`, `<button>`, …).
 * Typed `on*` handlers plus a permissive index signature so `data-*`,
 * `aria-*`, `class`, `style`, `id`, custom attributes — anything the user
 * needs — pass through without strict-typing each one.
 */
export type IntrinsicProps =
  & HtmlEventHandlers
  & Readonly<Record<string, unknown>>
