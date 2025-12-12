import { jest } from '@jest/globals';
import { RunnerStateService } from '../src/runner/RunnerStateService';

describe('RunnerStateService', () => {
    let service: RunnerStateService;

    beforeEach(() => {
        service = new RunnerStateService();
    });

    it('should initialize with created state', () => {
        expect(service.state).toBe('created');
    });

    it('should allow valid transitions', () => {
        expect(() => service.transitionTo('starting')).not.toThrow();
        expect(service.state).toBe('starting');

        expect(() => service.transitionTo('running')).not.toThrow();
        expect(service.state).toBe('running');

        expect(() => service.transitionTo('completed')).not.toThrow();
        expect(service.state).toBe('completed');
    });

    it('should emit stateChanged events', () => {
        const listener = jest.fn();
        service.on('stateChanged', listener);

        service.transitionTo('starting', { reason: 'test' });

        expect(listener).toHaveBeenCalledWith({
            from: 'created',
            to: 'starting',
            timestamp: expect.any(Number),
            metadata: { reason: 'test' }
        });
    });

    it('should throw on invalid transitions', () => {
        // created -> running (skip starting)
        expect(() => service.transitionTo('running')).toThrow();

        // created -> paused
        expect(() => service.transitionTo('paused')).toThrow();

        // Terminal state -> anything
        service.transitionTo('starting');
        service.transitionTo('failed');
        expect(() => service.transitionTo('running')).toThrow();
    });

    it('should track history', () => {
        service.transitionTo('starting');
        service.transitionTo('running');

        expect(service.history).toHaveLength(2);
        expect(service.history[0].to).toBe('starting');
        expect(service.history[1].to).toBe('running');
    });

    it('should ignore self-transitions', () => {
        service.transitionTo('starting');
        const listener = jest.fn();
        service.on('stateChanged', listener);

        service.transitionTo('starting');
        expect(listener).not.toHaveBeenCalled();
    });
});
