export class EngineLocator {
    private static _engine: any | null = null;

    static setEngine(engine: any): void {
        EngineLocator._engine = engine;
    }

    static getEngine<T = any>(): T | null {
        return EngineLocator._engine as T | null;
    }
}
