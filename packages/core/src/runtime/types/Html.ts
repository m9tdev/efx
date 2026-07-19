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
 * `mount.ts`): a returned `Effect` is run on the element's captured context —
 * its failure routes to the nearest boundary sink — and any other return
 * value is ignored (which keeps value-returning handlers like
 * `onclick={user.refetch}` legal; an exact `void | Effect` union would
 * reject them, since TS's void-return leniency doesn't apply to unions).
 * The handler's `E`/`R` are not read from this constraint; `h()` infers the
 * actual props type and folds them via `FoldPropsLiveE`/`FoldPropsR` (see
 * `Fold.ts`): `E` onto the element's live channel (`View<E>`), `R` into the
 * element's requirements.
 *
 * Known gap (inherent to reading the INFERRED props type): any hand-written
 * annotation wider than the Effect — `(): unknown =>`, or this constraint
 * shape itself — seals the handler's type and erases its channels, while the
 * runtime still runs the Effect. Annotate extracted handlers with the
 * exported {@link EventHandler} (which carries `E`/`R` slots) instead.
 */

import type { Effect } from "effect"

type Handler<E extends Event> = (event: E) => unknown

/**
 * The annotation type for an extracted handler. Unlike the permissive
 * in-constraint shape (`(event) => unknown`), this carries the channels, so
 * an annotated handler still folds:
 *
 *   const save: EventHandler<MouseEvent, HttpError, Http> =
 *     () => http.saveUser(draft)
 *
 * `<button onclick={save}/>` then stamps `View<HttpError>` and folds `Http`
 * exactly as the inline form would. Defaults keep plain handlers terse.
 */
export type EventHandler<Ev extends Event, E = never, R = never> = (
  event: Ev,
) => Effect.Effect<unknown, E, R> | void

export interface HtmlEventHandlers {
  // Pointer / mouse
  readonly onclick?: Handler<MouseEvent>
  readonly ondblclick?: Handler<MouseEvent>
  readonly onmousedown?: Handler<MouseEvent>
  readonly onmouseup?: Handler<MouseEvent>
  readonly onmouseover?: Handler<MouseEvent>
  readonly onmouseout?: Handler<MouseEvent>
  readonly onmouseenter?: Handler<MouseEvent>
  readonly onmouseleave?: Handler<MouseEvent>
  readonly onmousemove?: Handler<MouseEvent>
  readonly oncontextmenu?: Handler<MouseEvent>
  readonly onwheel?: Handler<WheelEvent>

  // Pointer events (broader than mouse — covers touch + pen)
  readonly onpointerdown?: Handler<PointerEvent>
  readonly onpointerup?: Handler<PointerEvent>
  readonly onpointermove?: Handler<PointerEvent>
  readonly onpointerover?: Handler<PointerEvent>
  readonly onpointerout?: Handler<PointerEvent>
  readonly onpointerenter?: Handler<PointerEvent>
  readonly onpointerleave?: Handler<PointerEvent>
  readonly onpointercancel?: Handler<PointerEvent>

  // Keyboard
  readonly onkeydown?: Handler<KeyboardEvent>
  readonly onkeyup?: Handler<KeyboardEvent>
  readonly onkeypress?: Handler<KeyboardEvent>

  // Focus
  readonly onfocus?: Handler<FocusEvent>
  readonly onblur?: Handler<FocusEvent>
  readonly onfocusin?: Handler<FocusEvent>
  readonly onfocusout?: Handler<FocusEvent>

  // Form
  readonly onsubmit?: Handler<SubmitEvent>
  readonly onreset?: Handler<Event>
  readonly oninvalid?: Handler<Event>
  readonly onchange?: Handler<Event>
  readonly oninput?: Handler<Event>
  readonly onselect?: Handler<Event>

  // Lifecycle / media / loading
  readonly onload?: Handler<Event>
  readonly onerror?: Handler<Event>
  readonly onscroll?: Handler<Event>
  readonly onresize?: Handler<UIEvent>
  readonly onabort?: Handler<Event>

  // Clipboard
  readonly oncopy?: Handler<ClipboardEvent>
  readonly oncut?: Handler<ClipboardEvent>
  readonly onpaste?: Handler<ClipboardEvent>

  // Drag & drop
  readonly ondragstart?: Handler<DragEvent>
  readonly ondrag?: Handler<DragEvent>
  readonly ondragend?: Handler<DragEvent>
  readonly ondragenter?: Handler<DragEvent>
  readonly ondragleave?: Handler<DragEvent>
  readonly ondragover?: Handler<DragEvent>
  readonly ondrop?: Handler<DragEvent>

  // Touch
  readonly ontouchstart?: Handler<TouchEvent>
  readonly ontouchmove?: Handler<TouchEvent>
  readonly ontouchend?: Handler<TouchEvent>
  readonly ontouchcancel?: Handler<TouchEvent>
}

/**
 * The props type assigned to every HTML intrinsic tag (`<div>`, `<button>`, …).
 * Typed `on*` handlers plus a permissive index signature so `data-*`,
 * `aria-*`, `class`, `style`, `id`, custom attributes — anything the user
 * needs — pass through without strict-typing each one.
 */
export type IntrinsicProps = HtmlEventHandlers &
  Readonly<Record<string, unknown>>
