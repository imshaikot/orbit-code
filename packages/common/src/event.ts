// The event and disposal shapes Orbit's services share across hosts. They match VS Code's own (vscode.Disposable,
// vscode.Event), so a service built on them goes into an extension's subscriptions as is, and a host without VS Code
// needs no VS Code types.

/** Something to let go of: a listener, a watcher, a process, a service. */
export interface Disposable {
  dispose(): void;
}

/** Subscribes a listener; disposing the result unsubscribes it. */
export type Event<T> = (listener: (value: T) => void) => Disposable;

/** Fires values to its listeners in the order they subscribed. A listener that throws is reported, and the rest still run. */
export class Emitter<T> implements Disposable {
  private listeners: ((value: T) => void)[] | undefined = [];

  readonly event: Event<T> = (listener) => {
    this.listeners?.push(listener);
    return {
      dispose: () => {
        const index = this.listeners?.indexOf(listener) ?? -1;
        if (index >= 0) this.listeners?.splice(index, 1);
      },
    };
  };

  fire(value: T): void {
    for (const listener of this.listeners?.slice() ?? []) {
      try {
        listener(value);
      } catch (error) {
        console.error(error);
      }
    }
  }

  /** Drops every listener; later subscriptions and fires do nothing. */
  dispose(): void {
    this.listeners = undefined;
  }
}
