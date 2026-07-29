export type CommentSendResult =
  | { status: 'accepted' | 'queued' }
  | { status: 'rejected' };

export function commentSendSucceeded(result: CommentSendResult): boolean {
  return result.status !== 'rejected';
}
