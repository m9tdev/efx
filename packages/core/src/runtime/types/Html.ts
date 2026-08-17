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
import type { Atom, AtomRef } from "effect/unstable/reactivity"

/**
 * A handler slot accepts the function itself or a REACTIVE handler — an
 * `Atom`/`AtomRef` holding one — mirroring `applyProp`, which subscribes to a
 * reactive prop and re-applies the current function as the live listener
 * (docs/reactivity-migration.md step 3). The props fold peels the wrapper
 * (`HandlerChannels` in Fold.ts), so a reactive handler's `E`/`R` still
 * surface. Contextual typing of `event` survives the union (pinned in
 * Fold.test-d.ts).
 */
type HandlerSlot<E extends Event> =
  | ((event: E) => unknown)
  | Atom.Atom<(event: E) => unknown>
  | AtomRef.ReadonlyRef<(event: E) => unknown>

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
  readonly onclick?: HandlerSlot<MouseEvent>
  readonly ondblclick?: HandlerSlot<MouseEvent>
  readonly onmousedown?: HandlerSlot<MouseEvent>
  readonly onmouseup?: HandlerSlot<MouseEvent>
  readonly onmouseover?: HandlerSlot<MouseEvent>
  readonly onmouseout?: HandlerSlot<MouseEvent>
  readonly onmouseenter?: HandlerSlot<MouseEvent>
  readonly onmouseleave?: HandlerSlot<MouseEvent>
  readonly onmousemove?: HandlerSlot<MouseEvent>
  readonly oncontextmenu?: HandlerSlot<MouseEvent>
  readonly onwheel?: HandlerSlot<WheelEvent>

  // Pointer events (broader than mouse — covers touch + pen)
  readonly onpointerdown?: HandlerSlot<PointerEvent>
  readonly onpointerup?: HandlerSlot<PointerEvent>
  readonly onpointermove?: HandlerSlot<PointerEvent>
  readonly onpointerover?: HandlerSlot<PointerEvent>
  readonly onpointerout?: HandlerSlot<PointerEvent>
  readonly onpointerenter?: HandlerSlot<PointerEvent>
  readonly onpointerleave?: HandlerSlot<PointerEvent>
  readonly onpointercancel?: HandlerSlot<PointerEvent>

  // Keyboard
  readonly onkeydown?: HandlerSlot<KeyboardEvent>
  readonly onkeyup?: HandlerSlot<KeyboardEvent>
  readonly onkeypress?: HandlerSlot<KeyboardEvent>

  // Focus
  readonly onfocus?: HandlerSlot<FocusEvent>
  readonly onblur?: HandlerSlot<FocusEvent>
  readonly onfocusin?: HandlerSlot<FocusEvent>
  readonly onfocusout?: HandlerSlot<FocusEvent>

  // Form
  readonly onsubmit?: HandlerSlot<SubmitEvent>
  readonly onreset?: HandlerSlot<Event>
  readonly oninvalid?: HandlerSlot<Event>
  readonly onchange?: HandlerSlot<Event>
  readonly oninput?: HandlerSlot<Event>
  readonly onselect?: HandlerSlot<Event>

  // Lifecycle / media / loading
  readonly onload?: HandlerSlot<Event>
  readonly onerror?: HandlerSlot<Event>
  readonly onscroll?: HandlerSlot<Event>
  readonly onresize?: HandlerSlot<UIEvent>
  readonly onabort?: HandlerSlot<Event>

  // Clipboard
  readonly oncopy?: HandlerSlot<ClipboardEvent>
  readonly oncut?: HandlerSlot<ClipboardEvent>
  readonly onpaste?: HandlerSlot<ClipboardEvent>

  // Drag & drop
  readonly ondragstart?: HandlerSlot<DragEvent>
  readonly ondrag?: HandlerSlot<DragEvent>
  readonly ondragend?: HandlerSlot<DragEvent>
  readonly ondragenter?: HandlerSlot<DragEvent>
  readonly ondragleave?: HandlerSlot<DragEvent>
  readonly ondragover?: HandlerSlot<DragEvent>
  readonly ondrop?: HandlerSlot<DragEvent>

  // Touch
  readonly ontouchstart?: HandlerSlot<TouchEvent>
  readonly ontouchmove?: HandlerSlot<TouchEvent>
  readonly ontouchend?: HandlerSlot<TouchEvent>
  readonly ontouchcancel?: HandlerSlot<TouchEvent>
}

/**
 * The props type assigned to every HTML intrinsic tag (`<div>`, `<button>`, …).
 * Typed `on*` handlers plus a permissive index signature so `data-*`,
 * `aria-*`, `class`, `style`, `id`, custom attributes — anything the user
 * needs — pass through without strict-typing each one.
 */
export type IntrinsicProps = HtmlEventHandlers &
  Readonly<Record<string, unknown>>
