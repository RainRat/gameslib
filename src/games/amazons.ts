import { GameBase, IAPGameState, IClickResult, IIndividualState, IValidationResult } from "./_base";
import { APGamesInformation } from "../schemas/gameinfo";
import { RectGrid } from "../common";
import { APRenderRep } from "@abstractplay/renderer/src/schema";
import { Directions } from "../common";
import { UndirectedGraph } from "graphology";
import bidirectional from 'graphology-shortest-path/unweighted';
import { APMoveResult } from "../schemas/moveresults";
import { reviver, UserFacingError } from "../common";
import i18next from "i18next";

const gameDesc:string = `# Amazons

A two-player game played on a 10x10 board. Each player has four queens (the eponymous amazons). Each turn, you move one of the queens and then shoot an arrow from your final square. The arrow causes that square to become blocked for the rest of the game. Queens and arrows cannot cross blocked squares or squares occupied by other queens. The winner is the last person who is able to move.

The game tree for Amazons, especially early in the game, is enormous, so the AI is very rudimentary.
`;

type CellContents = 0 | 1 | 2;
type playerid = 1|2;

interface IMoveState extends IIndividualState {
    currplayer: playerid;
    board: Map<string, CellContents>;
    lastmove?: string;
}

export interface IAmazonsState extends IAPGameState {
    winner: playerid[];
    stack: Array<IMoveState>;
};

export class AmazonsGame extends GameBase {
    public static readonly gameinfo: APGamesInformation = {
        name: "Amazons",
        uid: "amazons",
        playercounts: [2],
        version: "20211005",
        description: gameDesc,
        urls: ["https://en.wikipedia.org/wiki/Amazons_%28game%29"],
        people: [
            {
                type: "designer",
                name: "Walter Zamkauskas"
            }
        ],
        flags: ["multistep"]
    };
    public static coords2algebraic(x: number, y: number): string {
        return GameBase.coords2algebraic(x, y, 10);
    }
    public static algebraic2coords(cell: string): [number, number] {
        return GameBase.algebraic2coords(cell, 10);
    }

    private buildGraph(): UndirectedGraph {
        // Build the graph
        const graph = new UndirectedGraph();
        // Nodes
        for (let row = 0; row < 10; row++) {
            for (let col = 0; col < 10; col++) {
                graph.addNode(AmazonsGame.coords2algebraic(col, row));
            }
        }
        // Edges
        for (let row = 0; row < 10; row++) {
            for (let col = 0; col < 10; col++) {
                const fromCell = AmazonsGame.coords2algebraic(col, row);
                // Connect to the right
                if (col < 9) {
                    graph.addEdge(fromCell, AmazonsGame.coords2algebraic(col + 1, row));
                }
                // Connect up
                if (row > 0) {
                    graph.addEdge(fromCell, AmazonsGame.coords2algebraic(col, row - 1));
                }
                // Up right
                if ( (row > 0) && (col < 9) ) {
                    graph.addEdge(fromCell, AmazonsGame.coords2algebraic(col + 1, row - 1));
                }
                // Up left
                if ( (row > 0) && (col > 0) ) {
                    graph.addEdge(fromCell, AmazonsGame.coords2algebraic(col - 1, row - 1));
                }
            }
        }
        // Remove blocked nodes
        this.board.forEach((v, k) => {
            if (v === 0) {
                graph.dropNode(k);
            }
        });
        return graph;
    }

    public numplayers: number = 2;
    public currplayer!: playerid;
    public board!: Map<string, CellContents>;
    public lastmove?: string;
    public gameover: boolean = false;
    public winner: playerid[] = [];
    public graph!: UndirectedGraph;
    public stack!: Array<IMoveState>;
    public results: Array<APMoveResult> = [];
    public variants: string[] = [];

    constructor(state?: IAmazonsState | string) {
        super();
        if (state !== undefined) {
            if (typeof state === "string") {
                state = JSON.parse(state, reviver) as IAmazonsState;
            }
            if (state.game !== AmazonsGame.gameinfo.uid) {
                throw new Error(`The Amazons game code cannot process a game of '${state.game}'.`);
            }
            this.gameover = state.gameover;
            this.winner = [...state.winner];
            this.stack = [...state.stack];
        } else {
            const fresh: IMoveState = {
                _version: AmazonsGame.gameinfo.version,
                _results: [],
                currplayer: 1,
                board: new Map([
                    ["d10", 2],
                    ["g10", 2],
                    ["a7", 2],
                    ["j7", 2],
                    ["a4", 1],
                    ["j4", 1],
                    ["d1", 1],
                    ["g1", 1]
                ])
            };
            this.stack = [fresh];
        }
        this.load();
    }

    public load(idx: number = -1): AmazonsGame {
        if (idx < 0) {
            idx += this.stack.length;
        }
        if ( (idx < 0) || (idx >= this.stack.length) ) {
            throw new Error("Could not load the requested state from the stack.");
        }

        const state = this.stack[idx];
        if (state === undefined) {
            throw new Error(`Could not load state index ${idx}`);
        }
        this.results = [...state._results];
        this.currplayer = state.currplayer;
        this.board = new Map(state.board);
        this.lastmove = state.lastmove;
        this.graph = this.buildGraph();
        return this;
    }

    public moves(player?: 1|2): string[] {
        if (player === undefined) {
            player = this.currplayer;
        }
        if (this.gameover) {return [];}

        const grid = new RectGrid(10, 10);
        const dirs: Directions[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
        // Find the player's pieces
        const from: string[] = [];
        this.board.forEach((v, k) => {
            if (v === player) {
                from.push(k);
            }
        });
        const moves: Array<[string, string]> = [];
        from.forEach((fromCell) => {
            dirs.forEach((dir) => {
                const [x, y] = AmazonsGame.algebraic2coords(fromCell);
                const ray = grid.ray(x, y, dir);
                for (const cell of ray) {
                    const toCell = AmazonsGame.coords2algebraic(cell[0], cell[1]);
                    if (this.board.has(toCell)) {
                        break;
                    }
                    moves.push([fromCell, toCell]);
                }
            });
        });
        // For each move
        const finals: Array<[string, string, string]> = [];
        moves.forEach((m) => {
            dirs.forEach((dir) => {
                const [x, y] = AmazonsGame.algebraic2coords(m[1]);
                const ray = grid.ray(x, y, dir);
                for (const cell of ray) {
                    const toCell = AmazonsGame.coords2algebraic(cell[0], cell[1]);
                    if ( (this.board.has(toCell)) && (toCell !== m[0]) ) {
                        break;
                    }
                    finals.push([m[0], m[1], toCell]);
                }
            });
        });
        const allmoves: string[] = [];
        finals.forEach((move) => {
            allmoves.push(move[0] + "-" + move[1] + "/" + move[2]);
        });
        return allmoves;
    }

    public randomMove(): string {
        const moves = this.moves();
        return moves[Math.floor(Math.random() * moves.length)];
    }

    public handleClick(move: string, row: number, col: number, piece?: string): IClickResult {
        try {
            let newmove = "";
            const cell = AmazonsGame.coords2algebraic(col, row);
            if (this.board.has(cell)) {
                newmove = cell;
            }
            if (move.length > 0) {
                const [from, to,] = move.split(/[-\/]/);
                if ( (from !== undefined) && (to === undefined) ) {
                    newmove = `${from}-${cell}`;
                } else if ( (from !== undefined) && (to !== undefined) ) {
                    newmove = `${from}-${to}/${cell}`;
                } else {
                    newmove = move;
                }
            }
            if (newmove.length > 0) {
                const result = this.validateMove(newmove) as IClickResult;
                if (! result.valid) {
                    result.move = "";
                } else {
                    result.move = newmove;
                }
                return result;
            } else {
                return {move: "", message: ""} as IClickResult;
            }
        } catch (e) {
            return {
                move,
                valid: false,
                message: i18next.t("apgames:validation._general.GENERIC", {move, row, col, piece, emessage: (e as Error).message})
            }
        }
    }

    public validateMove(m: string): IValidationResult {
        const result: IValidationResult = {valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER")};
        if (m.length === 0) {
            result.message = i18next.t("apgames:validation._general.EMPTYSTRING");
            return result;
        }
        const [from, to, block] = m.split(/[-\/]/);
        // validate coordinates
        for (const cell of [from, to, block]) {
            if (cell !== undefined) {
                try {
                    AmazonsGame.algebraic2coords(cell);
                } catch {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation._general.INVALIDCELL", {cell});
                    return result
                }
            }
        }
        if (from !== undefined) {
            // trying to move a nonexistent piece
            if (! this.board.has(from)) {
                result.valid = false;
                result.message = i18next.t("apgames:validation._general.NONEXISTENT", {where: from});
                return result
            }
            // trying to move a piece you don't own
            if (this.board.get(from)! !== this.currplayer) {
                result.valid = false;
                result.message = i18next.t("apgames:validation._general.UNCONTROLLED");
                return result
            }
            // possible start of a move
            if (to === undefined) {
                result.valid = true;
                result.complete = -1;
                result.canrender = false;
                result.message = i18next.t("apgames:validation.amazons.POTENTIAL_MOVE");
                return result
            }
        }

        const grid = new RectGrid(10, 10);
        if (to !== undefined) {
            const [xFrom, yFrom] = AmazonsGame.algebraic2coords(from);
            const [xTo, yTo] = AmazonsGame.algebraic2coords(to);
            // destination is empty
            if (this.board.has(to)) {
                result.valid = false;
                result.message = i18next.t("apgames:validation._general.OCCUPIED", {where: to});
                return result;
            }
            // destination is in a straight line
            // `dir` can't be undefined because we already checked the destination is empty
            const dir = RectGrid.bearing(xFrom, yFrom, xTo, yTo)!;
            const ray = grid.ray(xFrom, yFrom, dir).map(pt => AmazonsGame.coords2algebraic(...pt));
            if (! ray.includes(to)) {
                result.valid = false;
                result.message = i18next.t("apgames:validation.amazons.STRAIGHTLINE");
                return result;
            }
            // nothing in the way
            for (const cell of ray) {
                if (cell === to) { break; }
                if (this.board.has(cell)) {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation._general.OBSTRUCTED", {from, to, obstruction: cell});
                    return result;
                }
            }
            // possible partial
            if (block === undefined) {
                result.valid = true;
                result.complete = -1;
                result.canrender = true;
                result.message = i18next.t("apgames:validation.amazons.POTENTIAL_BLOCK");
                return result
            }
        }

        if (block !== undefined) {
            const [xTo, yTo] = AmazonsGame.algebraic2coords(to);
            const [xBlock, yBlock] = AmazonsGame.algebraic2coords(block);
            // destination is empty, unless you're blocking your starting space
            if ( (this.board.has(block)) && (block !== from) ) {
                result.valid = false;
                result.message = i18next.t("apgames:validation._general.OCCUPIED", {where: block});
                return result;
            }
            // destination is in a straight line
            // `dir` can't be undefined because we already checked the destination is empty
            const dir = RectGrid.bearing(xTo, yTo, xBlock, yBlock)!;
            const ray = grid.ray(xTo, yTo, dir).map(pt => AmazonsGame.coords2algebraic(...pt));
            if (! ray.includes(block)) {
                result.valid = false;
                result.message = i18next.t("apgames:validation.amazons.STRAIGHTLINE");
                return result;
            }
            // nothing in the way, except potentially the moving piece
            for (const cell of ray) {
                if (cell === block) { break; }
                if ( (this.board.has(cell)) && (cell !== from) ) {
                    result.valid = false;
                    result.message = i18next.t("apgames:validation._general.OBSTRUCTED", {from, to, obstruction: cell});
                    return result;
                }
            }

            // looks good
            result.valid = true;
            result.complete = 1;
            result.message = i18next.t("apgames:validation._general.VALID_MOVE");
            return result
        }

        return result;
    }

    // The `partial` flag leaves the game object in an invalid state
    // Only use on a cloned object, or call `load()` before processing the final move
    public move(m: string, partial: boolean = false): AmazonsGame {
        if (this.gameover) {
            throw new UserFacingError("MOVES_GAMEOVER", i18next.t("apgames:MOVES_GAMEOVER"));
        }

        m = m.toLowerCase();
        m = m.replace(/\s+/g, "");
        const result = this.validateMove(m);
        if (! result.valid) {
            throw new UserFacingError("VALIDATION_GENERAL", result.message)
        }
        if (! this.moves().includes(m)) {
            throw new UserFacingError("VALIDATION_FAILSAFE", i18next.t("apgames:validation._general.FAILSAFE", {move: m}))
        }

        if (partial) {
            if ( (result.complete !== undefined) && (result.complete >= 0) || result.canrender === true ) {
                const [f, t, b] = m.split(/[-\/]/);
                if ( (f === undefined) || (t === undefined) ) {
                    throw new Error(`The move '${m}' is not a valid partial.`)
                }
                this.board.delete(f);
                this.board.set(t, this.currplayer);
                this.results = [{type: "move", from: f, to: t}];
                if (b !== undefined) {
                    this.board.set(b, 0);
                    this.results.push({type: "block", where: b})
                }
            } else {
                throw new Error(`The move '${m}' is not a valid partial.`)
            }
            return this;
        }

        // Move valid, so change the state
        const [from, to, block] = m.split(/[-\/]/);
        this.board.delete(from);
        this.board.set(to, this.currplayer);
        this.board.set(block, 0);
        this.graph.dropNode(block);
        this.lastmove = m;
        if (this.currplayer === 1) {
            this.currplayer = 2;
        } else {
            this.currplayer = 1;
        }
        // Assign results, don't add to them
        this.results = [
            {type: "move", from, to},
            {type: "block", where: block}
        ];

        this.checkEOG();
        this.saveState();
        return this;
    }

    protected checkEOG(): AmazonsGame {
        if (this.moves().length === 0) {
            this.gameover = true;
            // Here, though, we add to the results
            this.results.push({type: "eog"});
            if (this.currplayer === 1) {
                this.winner = [2];
            } else {
                this.winner = [1];
            }
            this.results.push({type: "winners", players: [...this.winner]});
        }
        return this;
    }

    public resign(player: 1|2): AmazonsGame {
        // Assign the results as this is an independent state changer
        this.results = [{type: "resigned", player}];
        this.gameover = true;
        this.results.push({type: "eog"});
        if (player === 1) {
            this.winner = [2];
        } else {
            this.winner = [1];
        }
        this.results.push({type: "winners", players: [...this.winner]});

        this.saveState();
        return this;
    }

    public state(): IAmazonsState {
        return {
            game: AmazonsGame.gameinfo.uid,
            numplayers: 2,
            variants: [],
            gameover: this.gameover,
            winner: [...this.winner],
            stack: [...this.stack]
        };
    }

    protected moveState(): IMoveState {
        return {
            _version: AmazonsGame.gameinfo.version,
            _results: [...this.results],
            currplayer: this.currplayer,
            lastmove: this.lastmove,
            board: new Map(this.board)
        };
    }

    public findPieces(): string[] {
        const pieces: string[] = [];
        this.board.forEach((v, k) => {
            if (v !== 0) {
                pieces.push(k);
            }
        });
        return pieces;
    }

    public areIsolated(): boolean {
        const pieces = this.findPieces();
        // Test if any opposing queens are connected
        for (let from = 0; from < pieces.length - 1; from++) {
            for (let to = from + 1; to < pieces.length; to++) {
                if (this.board.get(pieces[from]) === this.board.get(pieces[to])) {
                    continue;
                }
                const path = bidirectional(this.graph, pieces[from], pieces[to]);
                if (path !== null) {
                    return false;
                }
            }
        }
        return true;
    }

    public territory(): [number, number] {
        const pieces = this.findPieces();
        const countedOne: Set<string> = new Set();
        const countedTwo: Set<string> = new Set();
        pieces.forEach((start) => {
            const player = this.board.get(start);
            const toCheck: Set<string> = new Set([start]);
            const visited: Set<string> = new Set();
            while (toCheck.size > 0) {
                const cell = toCheck.values().next().value;
                toCheck.delete(cell);
                if (! visited.has(cell)) {
                    visited.add(cell);
                    const adjs = this.graph.neighbors(cell);
                    adjs.forEach((adj) => {
                        if (! this.board.has(adj)) {
                            toCheck.add(adj);
                            if (player === 1) {
                                countedOne.add(adj);
                            } else {
                                countedTwo.add(adj);
                            }
                        }
                    });
                }
            }
        });
        return [countedOne.size, countedTwo.size];
    }

    public render(): APRenderRep {
        // Build piece string
        let pstr: string = "";
        for (let row = 0; row < 10; row++) {
            if (pstr.length > 0) {
                pstr += "\n";
            }
            for (let col = 0; col < 10; col++) {
                const cell = AmazonsGame.coords2algebraic(col, row);
                if (this.board.has(cell)) {
                    const contents = this.board.get(cell);
                    switch (contents) {
                        case 0:
                            pstr += "X";
                            break;
                        case 1:
                            pstr += "R";
                            break;
                        case 2:
                            pstr += "B";
                            break;
                        default:
                            throw new Error("Unrecognized cell contents.");
                    }
                } else {
                    pstr += "-";
                }
            }
        }
        pstr = pstr.replace(/\-{10}/g, "_");

        // Build rep
        const rep: APRenderRep =  {
            board: {
                style: "squares-checkered",
                width: 10,
                height: 10
            },
            legend: {
                R: {
                    name: "chess-queen-solid-millenia",
                    player: 1
                },
                B: {
                    name: "chess-queen-solid-millenia",
                    player: 2
                },
                X: {
                    name: "piece-square",
                    colour: "#000"
                }
            },
            pieces: pstr
        };

        // Add annotations
        if (this.lastmove !== undefined) {
            const cells: string[] = this.lastmove.split(new RegExp('[\-\/]'));
            if (cells.length !== 3) {
                throw new Error(`Malformed last move: ${this.lastmove}`);
            }
            const [xFrom, yFrom] = AmazonsGame.algebraic2coords(cells[0]);
            const [xTo, yTo] = AmazonsGame.algebraic2coords(cells[1]);
            const [xArrow, yArrow] = AmazonsGame.algebraic2coords(cells[2]);
            rep.annotations = [
                {
                    type: "move",
                    targets: [
                        {col: xTo, row: yTo},
                        {col: xArrow, row: yArrow}
                    ],
                    style: "dashed"
                },
                {
                    type: "move",
                    targets: [
                        {col: xFrom, row: yFrom},
                        {col: xTo, row: yTo}
                    ]
                }
            ];
        }

        return rep;
    }

    public status(): string {
        if (this.gameover) {
            return `**GAME OVER**\n\nWinner: ${this.winner}\n\n`;
        }
        if (this.areIsolated()) {
            const t = this.territory();
            return `The queens are now isolated.\n\n**Territory**\n\nFirst player: ${t[0]}\n\nSecond player: ${t[1]}\n`;
        } else {
            return "";
        }
    }

    public chatLog(players: string[]): string[][] {
        // move, block, eog, resign, winners
        const result: string[][] = [];
        for (const state of this.stack) {
            if ( (state._results !== undefined) && (state._results.length > 0) ) {
                const node: string[] = [];
                let otherPlayer = state.currplayer + 1;
                if (otherPlayer > this.numplayers) {
                    otherPlayer = 1;
                }
                let name: string = `Player ${otherPlayer}`;
                if (otherPlayer <= players.length) {
                    name = players[otherPlayer - 1];
                }
                const move = state._results.find(r => r.type === "move");
                const block = state._results.find(r => r.type === "block");
                if ( (move !== undefined) && (block !== undefined) ) {
                    // @ts-ignore
                    node.push(i18next.t("apresults:MOVE.amazons", {player: name, from: move.from, to: move.to, block: block.where}));
                }
                for (const r of state._results) {
                    switch (r.type) {
                        case "eog":
                            node.push(i18next.t("apresults:EOG"));
                            break;
                        case "resigned":
                            let rname = `Player ${r.player}`;
                            if (r.player <= players.length) {
                                rname = players[r.player - 1]
                            }
                            node.push(i18next.t("apresults:RESIGN", {player: rname}));
                            break;
                        case "winners":
                            const names: string[] = [];
                            for (const w of r.players) {
                                if (w <= players.length) {
                                    names.push(players[w - 1]);
                                } else {
                                    names.push(`Player ${w}`);
                                }
                            }
                            node.push(i18next.t("apresults:WINNERS", {count: r.players.length, winners: names.join(", ")}));
                            break;
                    }
                }
                result.push(node);
            }
        }
        return result;
    }

    public clone(): AmazonsGame {
        return new AmazonsGame(this.serialize());
    }
}
