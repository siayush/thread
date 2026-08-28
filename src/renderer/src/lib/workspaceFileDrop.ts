/** Chat-column file drag/drop handlers — ported from t3's workspaceFileDrop.ts. */
import type { DragEvent } from 'react'

type WorkspaceFileDragEvent = DragEvent<HTMLElement>

export interface WorkspaceFileDropHost {
  setDragActive: (active: boolean) => void
  addFiles: (files: File[]) => void
}

function isFileDrag(event: WorkspaceFileDragEvent): boolean {
  return event.dataTransfer.types.includes('Files')
}

function movedWithinDropTarget(event: WorkspaceFileDragEvent): boolean {
  return event.relatedTarget !== null && event.currentTarget.contains(event.relatedTarget as Node)
}

export function makeWorkspaceFileDropHandlers(host: WorkspaceFileDropHost): {
  onDragEnter: (event: WorkspaceFileDragEvent) => void
  onDragOver: (event: WorkspaceFileDragEvent) => void
  onDragLeave: (event: WorkspaceFileDragEvent) => void
  onDrop: (event: WorkspaceFileDragEvent) => void
} {
  return {
    onDragEnter(event) {
      if (!isFileDrag(event)) return
      event.preventDefault()
      if (movedWithinDropTarget(event)) return
      host.setDragActive(true)
    },
    onDragOver(event) {
      if (!isFileDrag(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      host.setDragActive(true)
    },
    onDragLeave(event) {
      if (!isFileDrag(event)) return
      event.preventDefault()
      if (movedWithinDropTarget(event)) return
      host.setDragActive(false)
    },
    onDrop(event) {
      if (!isFileDrag(event)) return
      event.preventDefault()
      host.setDragActive(false)
      host.addFiles(Array.from(event.dataTransfer.files))
    }
  }
}
