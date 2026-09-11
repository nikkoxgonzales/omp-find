export interface FindCommandDeps {
    search?: any;
    frecency?: any;
    [key: string]: any;
}
export declare function registerFindCommands(pi: any, deps?: FindCommandDeps): void;
