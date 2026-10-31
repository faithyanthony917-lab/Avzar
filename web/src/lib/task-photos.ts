/** Same-origin paths for task-scoped photo endpoints. Authorization is always enforced by the API. */
export function taskPhotosApiPath(taskId: string, workerOnly: boolean): string {
  return `${workerOnly ? '/api/my/tasks' : '/api/tasks'}/${encodeURIComponent(taskId)}/photos`;
}

export function taskPhotoFilePath(taskId: string, photoId: string, workerOnly: boolean): string {
  return `${taskPhotosApiPath(taskId, workerOnly)}/${encodeURIComponent(photoId)}/file/md`;
}
