/** Same-origin paths for order reference images. Authorization is always enforced by the API. */
export function orderReferenceImagesPath(orderId: string): string {
  return `/api/orders/${encodeURIComponent(orderId)}/reference-images`;
}

export function orderReferenceImageFilePath(orderId: string, imageId: string, variant: 'md' | 'orig' = 'md'): string {
  return `${orderReferenceImagesPath(orderId)}/${encodeURIComponent(imageId)}/file/${variant}`;
}

/** A worker reaches the images of an order only through a task assigned to them. */
export function taskReferenceImagesPath(taskId: string): string {
  return `/api/my/tasks/${encodeURIComponent(taskId)}/reference-images`;
}

export function taskReferenceImageFilePath(taskId: string, imageId: string, variant: 'md' | 'orig' = 'md'): string {
  return `${taskReferenceImagesPath(taskId)}/${encodeURIComponent(imageId)}/file/${variant}`;
}
