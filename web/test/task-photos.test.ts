import { describe, expect, it } from 'vitest';
import { taskPhotoFilePath, taskPhotosApiPath } from '../src/lib/task-photos';

describe('task progress photo endpoint paths', () => {
  it('uses assigned-worker endpoints for photo upload and listing', () => {
    expect(taskPhotosApiPath('task-id', true)).toBe('/api/my/tasks/task-id/photos');
    expect(taskPhotoFilePath('task-id', 'photo-id', true)).toBe('/api/my/tasks/task-id/photos/photo-id/file/md');
  });
  it('uses manager endpoints for read-only photo galleries', () => {
    expect(taskPhotosApiPath('task-id', false)).toBe('/api/tasks/task-id/photos');
    expect(taskPhotoFilePath('task-id', 'photo-id', false)).toBe('/api/tasks/task-id/photos/photo-id/file/md');
  });
  it('encodes identifiers rather than allowing path-segment injection', () => {
    expect(taskPhotoFilePath('task/a', 'photo?b', true)).toBe('/api/my/tasks/task%2Fa/photos/photo%3Fb/file/md');
  });
});
