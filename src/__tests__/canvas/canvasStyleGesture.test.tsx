import { afterEach, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useCanvasStyleGesture } from '@site/canvas/canvasStyleGesture'

afterEach(cleanup)

it('commits only the captured pointer and cancels when the edit target changes', () => {
  const move = mock()
  const end = mock()
  const cancel = mock()
  function Handle({ target }: { target: string }) {
    const capture = useCanvasStyleGesture(target)
    return <div data-testid="handle" onPointerDown={(event) => capture(event, { move, end, cancel })} />
  }
  const view = render(<Handle target="first" />)
  const handle = view.getByTestId('handle')
  handle.setPointerCapture = () => {}
  handle.hasPointerCapture = () => false
  const pointer = { isPrimary: true, pointerId: 1, button: 0 }
  fireEvent.pointerDown(handle, pointer)
  fireEvent.pointerMove(handle, { ...pointer, pointerId: 2 })
  fireEvent.pointerUp(handle, { ...pointer, pointerId: 2 })
  expect(move).not.toHaveBeenCalled()
  expect(end).not.toHaveBeenCalled()
  fireEvent.pointerMove(handle, pointer)
  expect(move).toHaveBeenCalledTimes(1)
  view.rerender(<Handle target="second" />)
  fireEvent.pointerUp(handle, pointer)
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(end).not.toHaveBeenCalled()

  fireEvent.pointerDown(handle, pointer)
  fireEvent.pointerCancel(handle, pointer)
  expect(cancel).toHaveBeenCalledTimes(2)
  fireEvent.pointerDown(handle, pointer)
  fireEvent.pointerUp(handle, pointer)
  expect(end).toHaveBeenCalledTimes(1)
})
