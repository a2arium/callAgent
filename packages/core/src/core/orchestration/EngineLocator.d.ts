export declare class EngineLocator {
    private static _engine;
    static setEngine(engine: any): void;
    static getEngine<T = any>(): T | null;
}
