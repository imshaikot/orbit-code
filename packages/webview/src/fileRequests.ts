import type { FileReply, FileRequest } from '@orbit-code/protocol';
import type { HostBridge } from './host';

export type FollowListener = (reply: FileReply, path: string) => void;

/**
 * The file menu's and the editor sheet's requests to the host, each matched to its reply by id. A read also follows
 * the file: what changes elsewhere keeps arriving under the read's id until `unfollow`.
 */
export class FileRequests {
  private next = 1;
  private readonly waiting = new Map<number, (reply: FileReply) => void>();
  private readonly followers = new Map<number, FollowListener>();

  constructor(private readonly host: HostBridge) {
    host.on('file', ({ id, path, reply }) => {
      const resolve = this.waiting.get(id);
      if (resolve) {
        this.waiting.delete(id);
        resolve(reply);
      } else {
        this.followers.get(id)?.(reply, path);
      }
    });
  }

  send(path: string, request: FileRequest): Promise<FileReply> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.host.post({ type: 'file', id, path, request });
    });
  }

  /** Reads `path`; `later` gets the changes made to it elsewhere. */
  follow(path: string, later: FollowListener): { id: number; first: Promise<FileReply> } {
    const id = this.next++;
    this.followers.set(id, later);
    const first = new Promise<FileReply>((resolve) => this.waiting.set(id, resolve));
    this.host.post({ type: 'file', id, path, request: { kind: 'read' } });
    return { id, first };
  }

  unfollow(id: number): void {
    this.followers.delete(id);
  }
}
