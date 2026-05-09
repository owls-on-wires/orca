import { produce } from 'immer';
import { State } from '../types/types';

class ImmutableStore<T> {
  private state: T;

  constructor(initialState: T) {
    this.state = initialState;
  }

  get(): T {
    return this.state;
  }

  update(updater: (draft: T) => void): void {
    this.state = produce(this.state, updater);
  }
}

let store: ImmutableStore<State>;

const getInitialState = (): State => {
  return {
    theme: 'light',
    connected: false,
    stats: null,
    executorState: null,
  };
};

export const initializeState = (): State => {
  store = new ImmutableStore(getInitialState());
  return store.get();
};

export const get = (): State => {
  return store.get();
};

export const update = (updater: (draft: State) => void): void => {
  store.update(updater);
};
