const editableSelector = "input, textarea, select, [contenteditable=''], [contenteditable='true']"

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

// Caret positions and string lengths are UTF-16 code units, but a code point
// outside the BMP is two of them. Moving or deleting a single unit would leave
// the caret inside a pair, and deleting one half would strand a lone surrogate
// in the value, which renders as U+FFFD and can never match anything again.
function step(value: string, index: number, delta: -1 | 1) {
  if (delta < 0) {
    const width = isLowSurrogate(value.charCodeAt(index - 1)) && isHighSurrogate(value.charCodeAt(index - 2)) ? 2 : 1
    return Math.max(0, index - width)
  }
  const width = isHighSurrogate(value.charCodeAt(index)) && isLowSurrogate(value.charCodeAt(index + 1)) ? 2 : 1
  return Math.min(value.length, index + width)
}

export function handleDocumentSearchKeydown(
  input: HTMLInputElement | undefined,
  event: KeyboardEvent,
  inputValue: string,
  setInputValue: (value: string) => void,
) {
  if (!input) return false
  if (event.defaultPrevented || event.isComposing) return false
  if (event.target === input) return false
  if (event.target instanceof Element && event.target.closest(editableSelector)) return false

  const action = searchKeyAction(event)
  if (!action) return false

  event.preventDefault()
  event.stopPropagation()
  input.focus()

  const start = input.selectionStart ?? inputValue.length
  const end = input.selectionEnd ?? inputValue.length

  if (action.type === "selectAll") {
    input.setSelectionRange(0, inputValue.length)
    return true
  }

  if (action.type === "move") {
    moveSelection(input, inputValue, action.delta, event.shiftKey)
    return true
  }

  if (action.type === "home") {
    setBoundarySelection(input, start, 0, event.shiftKey)
    return true
  }

  if (action.type === "end") {
    setBoundarySelection(input, start, inputValue.length, event.shiftKey)
    return true
  }

  if (action.type === "deleteBackward") {
    if (start !== end)
      return updateValue(input, inputValue.slice(0, start) + inputValue.slice(end), start, setInputValue)
    if (start === 0) return true
    const from = step(inputValue, start, -1)
    return updateValue(input, inputValue.slice(0, from) + inputValue.slice(end), from, setInputValue)
  }

  if (action.type === "deleteForward") {
    if (start !== end)
      return updateValue(input, inputValue.slice(0, start) + inputValue.slice(end), start, setInputValue)
    if (end === inputValue.length) return true
    const to = step(inputValue, end, 1)
    return updateValue(input, inputValue.slice(0, start) + inputValue.slice(to), start, setInputValue)
  }

  return updateValue(
    input,
    inputValue.slice(0, start) + action.value + inputValue.slice(end),
    start + action.value.length,
    setInputValue,
  )
}

function searchKeyAction(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "a") {
    return { type: "selectAll" } as const
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined
  if (event.key.length === 1) return { type: "insert", value: event.key } as const
  if (event.key === "Backspace") return { type: "deleteBackward" } as const
  if (event.key === "Delete") return { type: "deleteForward" } as const
  if (event.key === "ArrowLeft") return { type: "move", delta: -1 } as const
  if (event.key === "ArrowRight") return { type: "move", delta: 1 } as const
  if (event.key === "Home") return { type: "home" } as const
  if (event.key === "End") return { type: "end" } as const
  // A code point outside the BMP is two code units, so a length check dropped
  // every emoji and other astral character instead of inserting it.
  if (event.key.length === 1 || (event.key.length === 2 && isHighSurrogate(event.key.charCodeAt(0))))
    return { type: "insert", value: event.key } as const
  return undefined
}

function moveSelection(input: HTMLInputElement, inputValue: string, delta: -1 | 1, extend: boolean) {
  const start = input.selectionStart ?? inputValue.length
  const end = input.selectionEnd ?? inputValue.length
  if (!extend && start !== end) {
    const caret = delta < 0 ? start : end
    input.setSelectionRange(caret, caret)
    return
  }

  if (!extend) {
    const caret = step(inputValue, start, delta)
    input.setSelectionRange(caret, caret)
    return
  }

  const backward = input.selectionDirection === "backward"
  const anchor = backward ? end : start
  const focus = backward ? start : end
  const next = step(inputValue, focus, delta)
  input.setSelectionRange(Math.min(anchor, next), Math.max(anchor, next), next < anchor ? "backward" : "forward")
}

function setBoundarySelection(input: HTMLInputElement, anchor: number, focus: number, extend: boolean) {
  if (!extend) {
    input.setSelectionRange(focus, focus)
    return
  }
  input.setSelectionRange(Math.min(anchor, focus), Math.max(anchor, focus), focus < anchor ? "backward" : "forward")
}

function updateValue(input: HTMLInputElement, value: string, caret: number, setInputValue: (value: string) => void) {
  input.value = value
  setInputValue(value)
  input.setSelectionRange(caret, caret)
  return true
}
