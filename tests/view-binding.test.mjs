import assert from 'node:assert/strict'
import test from 'node:test'
import { appInstanceId, currentViewId } from '../src/client/view-binding.ts'

const meta = {
  kind: 'dsh/mcp-app',
  version: 1,
  viewId: 'persisted-process-view',
  publicToolName: 'mcp__threejs__open_editor',
  resourceUri: 'ui://threejs-editor/app',
  result: { content: [] },
}

test('rebinds a persisted App result to the current process view', () => {
  assert.equal(currentViewId(meta, {
    viewId: 'current-process-view',
    publicToolName: meta.publicToolName,
    resourceUri: meta.resourceUri,
    sandboxOrigin: 'http://127.0.0.1:1234',
  }), 'current-process-view')
})

test('rejects a changed App definition', () => {
  assert.throws(() => currentViewId(meta, {
    viewId: 'current-process-view',
    publicToolName: meta.publicToolName,
    resourceUri: 'ui://other/app',
    sandboxOrigin: 'http://127.0.0.1:1234',
  }), /definition no longer matches/)
})

test('deduplicates repeated canvas results without merging different canvases', () => {
  const canvasMeta = canvasPath => ({
    ...meta,
    result: {
      content: [],
      structuredContent: { canvasPath },
    },
  })

  assert.equal(
    appInstanceId(canvasMeta('designs/demo/main.excalidraw'), 'excalidraw', 'call-1'),
    appInstanceId(canvasMeta('designs/demo/main.excalidraw'), 'excalidraw', 'call-2'),
  )
  assert.notEqual(
    appInstanceId(canvasMeta('designs/demo/main.excalidraw'), 'excalidraw', 'call-1'),
    appInstanceId(canvasMeta('designs/demo/other.excalidraw'), 'excalidraw', 'call-2'),
  )
})
