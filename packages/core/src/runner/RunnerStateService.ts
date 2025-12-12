import { EventEmitter } from 'node:events';

export type RunnerStatus =
    | 'created'
    | 'starting'
    | 'running'
    | 'paused'
    | 'completed'
    | 'failed';

export interface StateChangeEvent {
    from: RunnerStatus;
    to: RunnerStatus;
    timestamp: number;
    metadata?: Record<string, unknown>;
}

export class RunnerStateService extends EventEmitter {
    private _state: RunnerStatus = 'created';
    private _history: StateChangeEvent[] = [];

    constructor(initialState: RunnerStatus = 'created') {
        super();
        this._state = initialState;
    }

    get state(): RunnerStatus {
        return this._state;
    }

    get history(): StateChangeEvent[] {
        return [...this._history];
    }

    /**
     * Transition to a new state
     * @param newState Target state
     * @param metadata Optional metadata describing the transition
     */
    transitionTo(newState: RunnerStatus, metadata?: Record<string, unknown>): void {
        if (this._state === newState) {
            return;
        }

        const valid = this.validateTransition(this._state, newState);
        if (!valid) {
            throw new Error(`Invalid state transition from ${this._state} to ${newState}`);
        }

        const event: StateChangeEvent = {
            from: this._state,
            to: newState,
            timestamp: Date.now(),
            metadata
        };

        this._state = newState;
        this._history.push(event);
        this.emit('stateChanged', event);
    }

    private validateTransition(from: RunnerStatus, to: RunnerStatus): boolean {
        // Basic state machine validation
        switch (from) {
            case 'created':
                return to === 'starting' || to === 'failed';
            case 'starting':
                return to === 'running' || to === 'failed';
            case 'running':
                return to === 'paused' || to === 'completed' || to === 'failed';
            case 'paused':
                return to === 'running' || to === 'completed' || to === 'failed';
            case 'completed':
            case 'failed':
                return false; // Terminal states
            default:
                return false;
        }
    }
}
