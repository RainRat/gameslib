/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-var-requires */
import { GameBase, IAPGameState, IClickResult, IIndividualState, IRenderOpts, IScores, IValidationResult } from "./_base";
import { APGamesInformation } from "../schemas/gameinfo";
import { APRenderRep } from "@abstractplay/renderer/src/schemas/schema";
import { APMoveResult } from "../schemas/moveresults";
import { reviver, UserFacingError } from "../common";
import i18next from "i18next";
import { HexTriGraph } from "../common/graphs";

export type playerid = 1|2;
type directions = "NE"|"E"|"SE"|"SW"|"W"|"NW";
const allDirections: directions[] = ["NE","E","SE","SW","W","NW"];

interface ILooseObj {
    [key: string]: any;
}

export interface IMoveState extends IIndividualState {
    currplayer: playerid;
    board: Map<string, playerid>;
    lastmove?: string;
    scores: [number, number];
    buttontaker?: playerid;
    komi?: number;
};

export interface IStigmergyState extends IAPGameState {
    winner: playerid[];
    stack: Array<IMoveState>;
};

export class StigmergyGame extends GameBase {
    public static readonly gameinfo: APGamesInformation = {
        name: "Stigmergy",
        uid: "stigmergy",
        playercounts: [2],
        version: "20240524",
        dateAdded: "2024-05-24",
        // i18next.t("apgames:descriptions.stigmergy")
        description: "apgames:descriptions.stigmergy",
        // i18next.t("apgames:notes.stigmergy")
        notes: "apgames:notes.stigmergy",
        urls: ["https://boardgamegeek.com/boardgame/333767/stigmergy"],
        people: [
            {
                type: "designer",
                name: "Steve Metzger",
                urls: ["https://boardgamegeek.com/boardgamedesigner/11879/steve-metzger"]
            },
            {
                type: "designer",
                name: "Luis Bolaños Mures",
                urls: ["https://boardgamegeek.com/boardgamedesigner/47001/luis-bolanos-mures"]
            }
        ],
        categories: ["goal>area", "mechanic>place",  "mechanic>capture", "board>shape>hex"],
        flags: ["experimental", "pie-even", "scores", "automove"],
        variants: [
            {
                uid: "size-7",
                group: "board",
            },
            {
                uid: "size-9",
                group: "board",
            },
            {
                uid: "size-10",
                group: "board",
            }
        ],
        displays: [{uid: "hide-threatened"}, {uid: "hide-influence"}, {uid: "hide-both"}],
    };

    public numplayers = 2;
    public currplayer: playerid = 1;
    public board!: Map<string, playerid>;
    public graph?: HexTriGraph;
    public gameover = false;
    public winner: playerid[] = [];
    public variants: string[] = [];
    public stack!: Array<IMoveState>;
    public results: Array<APMoveResult> = [];
    public scores: [number, number] = [0, 0];
    public buttontaker?: playerid;
    public komi?: number;
    private boardSize = 0;

    constructor(state?: IStigmergyState | string, variants?: string[]) {
        super();
        if (state === undefined) {
            if (variants !== undefined) {
                this.variants = [...variants];
            }
            // Graph and board size properties are assigned after because
            // they're common to both fresh and loaded games.
            const board: Map<string, playerid> = new Map();
            const fresh: IMoveState = {
                _version: StigmergyGame.gameinfo.version,
                _results: [],
                _timestamp: new Date(),
                currplayer: 1,
                board,
                scores: [0, 0]
            };
            this.stack = [fresh];
        } else {
            if (typeof state === "string") {
                state = JSON.parse(state, reviver) as IStigmergyState;
            }
            if (state.game !== StigmergyGame.gameinfo.uid) {
                throw new Error(`The Stigmergy engine cannot process a game of '${state.game}'.`);
            }
            this.gameover = state.gameover;
            this.winner = [...state.winner];
            this.variants = state.variants;
            this.stack = [...state.stack];
        }
        this.boardSize = this.getBoardSize();
        this.load();
        this.buildGraph();
    }

    public load(idx = -1): StigmergyGame {
        if (idx < 0) {
            idx += this.stack.length;
        }
        if ( (idx < 0) || (idx >= this.stack.length) ) {
            throw new Error("Could not load the requested state from the stack.");
        }

        const state = this.stack[idx];
        this.currplayer = state.currplayer;
        this.board = new Map(state.board);
        this.lastmove = state.lastmove;
        this.results = [...state._results];
        this.scores = [...state.scores];
        this.buttontaker = state.buttontaker;
        this.komi = state.komi;
        return this;
    }

    private buildGraph(): HexTriGraph {
        this.graph = new HexTriGraph(this.boardSize, (this.boardSize * 2) - 1);
        return this.graph;
    }

    private getGraph(boardSize?: number): HexTriGraph {
        if (boardSize === undefined) {
            return (this.graph === undefined) ? this.buildGraph() : this.graph;
        } else {
            return new HexTriGraph(boardSize, (boardSize * 2) - 1);
        }
    }

    // Fixes known issue with some edge cases not calling load
    private listCells(ordered = false): string[] | string[][] {
        try {
            if (ordered === undefined) {
                return this.getGraph().listCells();
            } else {
                return this.getGraph().listCells(ordered);
            }
        } catch (e) {
            return this.buildGraph().listCells(ordered);
        }
    }

    private getBoardSize(): number {
        // Get board size from variants.
        if ( (this.variants !== undefined) && (this.variants.length > 0) && (this.variants[0] !== undefined) && (this.variants[0].length > 0) ) {
            const sizeVariants = this.variants.filter(v => v.includes("size"))
            if (sizeVariants.length > 0) {
                const size = sizeVariants[0].match(/\d+/);
                return parseInt(size![0], 10);
            }
            if (isNaN(this.boardSize)) {
                throw new Error(`Could not determine the board size from variant "${this.variants[0]}"`);
            }
        }
        return 8;
    }

    public moves(player?: playerid): string[] {
        if (this.gameover) { return []; }
        if (player === undefined) {
            player = this.currplayer;
        }
        let freeSpaces = false;
        const otherPlayer = this.getOtherPlayer(player);

        if (this.stack.length === 1) {
            return [];
        } else if (this.stack.length === 2) {
            return ["pass"];
        }

        const moves: string[] = [];
        for (const cell of this.listCells() as string[]) {
            const losTarget = Math.floor(this.getGraph().neighbours(cell).length / 2) + 1;
            const playerLos = this.getLosCount(cell, player);
            const otherPlayerLos = this.getLosCount(cell, otherPlayer);

            if (this.board.has(cell) && this.board.get(cell) === otherPlayer && playerLos >= losTarget) {
                moves.push(cell);
            } else if (!this.board.has(cell) && otherPlayerLos < losTarget) {
                moves.push(cell);
            }

            if (!freeSpaces && !this.board.has(cell) && playerLos < losTarget && otherPlayerLos < losTarget) {
                freeSpaces = true;
            }
        }
        if (this.isButtonActive()) moves.push("_btn|takebutton|button");
        if (!freeSpaces && !this.isButtonActive()) moves.push("pass");
        return moves;
    }

    private isButtonActive(): boolean {
        return this.buttontaker === undefined && this.komi !== undefined && this.komi % 2 === 1;
    }

    public randomMove(): string {
        const moves = this.moves();
        return moves[Math.floor(Math.random() * moves.length)];
    }

    public handleClick(move: string, row: number, col: number, piece?: string): IClickResult {
        try {
            if (this.stack.length < 3) {
                const dummyResult = this.validateMove("") as IClickResult;
                dummyResult.move = "";
                return dummyResult;
            }

            const newmove = this.getGraph().coords2algebraic(col, row);
            const result = this.validateMove(newmove) as IClickResult;
            if (!result.valid) {
                result.move = move;
            } else {
                result.move = newmove;
            }
            return result;
        } catch (e) {
            return {
                move,
                valid: false,
                message: i18next.t("apgames:validation._general.GENERIC", {move, row, col, piece, emessage: (e as Error).message})
            }
        }
    }

    private getLosCount(cell: string, player: playerid): number {
        let losCount = 0;
        for (const dir of allDirections) {
            const ray = this.getGraph().ray(...this.getGraph().algebraic2coords(cell), dir).map(c => this.getGraph().coords2algebraic(c[0], c[1]));
            for (const c of ray) {
                if (this.board.has(c)) {
                    if (this.board.get(c)! === player) {
                        losCount++;
                    }
                    break;
                }
            }
        }
        return losCount;
    }

    public validateMove(m: string): IValidationResult {
        m = m.toLowerCase();
        m = m.replace(/\s+/g, "");

        const result: IValidationResult = {valid: false, message: i18next.t("apgames:validation._general.DEFAULT_HANDLER")};

        if (this.stack.length === 1) {
            if (m.length === 0) {
                result.valid = true;
                result.complete = -1;
                result.message = i18next.t("apgames:validation.stigmergy.INITIAL_SETUP");
                return result;
            }

            try {
                parseInt(m, 10);
                result.valid = true;
                result.complete = 0;
                result.message = i18next.t("apgames:validation.stigmergy.INITIAL_SETUP");
                return result;
            } catch {
                result.valid = false;
                result.message = i18next.t("apgames:validation.stigmergy.INVALIDKOMI");
                return result;
            }
        }

        if (m.length === 0) {
            result.valid = true;
            result.complete = -1;
            if (this.stack.length === 2) {
                result.message = i18next.t("apgames:validation.stigmergy.KOMI_CHOICE");
            } else if (this.isButtonActive())
                result.message = i18next.t("apgames:validation.stigmergy.INITIAL_INSTRUCTIONS_BUTTON");
            else
                result.message = i18next.t("apgames:validation.stigmergy.INITIAL_INSTRUCTIONS");
            return result;
        }

        if (m === "pass") {
            if (this.moves().includes("pass")) {
                result.valid = true;
                result.complete = 1;
                result.message = i18next.t("apgames:validation._general.VALID_MOVE");
                return result;
            } else {
                result.valid = false;
                result.message = i18next.t("apgames:validation.stigmergy.INVALIDPASS");
                return result;
            }
        }

        if (m === "button") {
            if (this.isButtonActive()) {
                result.valid = true;
                result.complete = 1;
                result.message = i18next.t("apgames:validation._general.VALID_MOVE");
                return result;
            } else {
                result.valid = false;
                result.message = i18next.t("apgames:validation.stigmergy.INVALIDBUTTON");
                return result;
            }
        }

        // valid cell
        try {
            this.getGraph().algebraic2coords(m);
        } catch {
            result.valid = false;
            result.message = i18next.t("apgames:validation._general.INVALIDCELL", {cell: m});
            return result;
        }

        if (this.board.has(m) && this.board.get(m) === this.currplayer) {
            result.valid = false;
            if (this.isButtonActive())
                result.message = i18next.t("apgames:validation.stigmergy.INITIAL_INSTRUCTIONS_BUTTON");
            else
                result.message = i18next.t("apgames:validation.stigmergy.INITIAL_INSTRUCTIONS");
            return result;
        }

        let losCount = this.getLosCount(m, this.currplayer);
        const otherPlayer = this.getOtherPlayer(this.currplayer);
        const losTarget = Math.floor(this.getGraph().neighbours(m).length / 2) + 1;
        if (this.board.has(m) && this.board.get(m) === this.getOtherPlayer(this.currplayer) && losCount < losTarget) {
            result.valid = false;
            result.message = i18next.t("apgames:validation.stigmergy.INSUFFICIENT_LOS", {cell: m});
            return result;
        }

        losCount = this.getLosCount(m, otherPlayer);
        if (!this.board.has(m) && losCount >= losTarget) {
            result.valid = false;
            result.message = i18next.t("apgames:validation.stigmergy.OPPONENT_CONTROL", {cell: m});
            return result;
        }

        // we're good
        result.valid = true;
        result.complete = 1;
        result.canrender = true;
        result.message = i18next.t("apgames:validation._general.VALID_MOVE");

        return result;
    }

    public move(m: string, { partial = false, trusted = false } = {}): StigmergyGame {
        if (this.gameover) {
            throw new UserFacingError("MOVES_GAMEOVER", i18next.t("apgames:MOVES_GAMEOVER"));
        }

        if (m.length === 0) return this;

        m = m.toLowerCase();
        m = m.replace(/\s+/g, "");
        if (!trusted) {
            const result = this.validateMove(m);
            if (!result.valid) {
                throw new UserFacingError("VALIDATION_GENERAL", result.message)
            }
            if (!partial && this.stack.length > 1 && !this.moves().includes(m) && (!this.isButtonActive() || m !== "button")) {
                throw new UserFacingError("VALIDATION_FAILSAFE", i18next.t("apgames:validation._general.FAILSAFE", {move: m}))
            }
        }

        this.results = [];
        if (this.stack.length === 1) {
            this.komi = parseInt(m, 10);
            this.results.push({type: "komi", value: this.komi});
        } else if (m === "pass") {
            this.results.push({type: "pass"});
        } else if (m === "button") {
            this.buttontaker = this.currplayer;
            this.results.push({type: "button"});
        } else {
            if (this.board.has(m)) {
                this.results.push({type: "capture", where: m});
            } else {
                this.results.push({type: "place", where: m});
            }
            this.board.set(m, this.currplayer);
        }

        // update currplayer
        this.lastmove = m;
        this.currplayer = this.getOtherPlayer(this.currplayer);

        this.updateScores();
        this.checkEOG();
        this.saveState();
        return this;
    }

    private getOtherPlayer(player: playerid): playerid {
        const otherplayer = (player as number) + 1;
        if (otherplayer > this.numplayers) return 1;
        return otherplayer as playerid;
    }

    private cellOwner(cell: string): playerid | undefined {
        if (this.board.has(cell)) return this.board.get(cell);
        const losTarget = Math.floor(this.getGraph().neighbours(cell).length / 2) + 1;
        const player1Los = this.getLosCount(cell, 1);
        const player2Los = this.getLosCount(cell, 2);
        if (player1Los >= losTarget) {
            return 1;
        } else if (player2Los >= losTarget) {
            return 2;
        }
        return undefined;
    }

    private updateScores(): void {
        // Updates `this.scores` with total influence for each player.
        this.scores = [0, 0];
        for (const cell of this.listCells() as string[]) {
            const owner = this.cellOwner(cell);
            if (owner !== undefined) {
                this.scores[owner - 1]++;
            }
        }
    }

    private pieceCount(player: playerid): number {
        // Get number of piece on board for `player`.
        return [...this.board.values()].filter(v => v === player).length;
    }

    protected checkEOG(): StigmergyGame {
        if (this.lastmove === "pass" && this.stack[this.stack.length - 1].lastmove === "pass") {
            this.gameover = true;
            const p1Score = this.getPlayerScore(1);
            const p2Score = this.getPlayerScore(2);
            this.winner = p1Score > p2Score ? [1] : p1Score < p2Score ? [2] : [1, 2];
        }
        if (this.gameover) {
            this.results.push(
                {type: "eog"},
                {type: "winners", players: [...this.winner]}
            );
        }
        return this;
    }

    public getPlayerScore(player: playerid): number {
        return this.scores[player - 1] + ((this.buttontaker === player) ? .5 : 0) + ((player === 2 && this.komi !== undefined) ? this.komi : 0);
    }

    public getPlayersScores(): IScores[] {
        return [
            { name: i18next.t("apgames:status.SCORES"), scores: [this.getPlayerScore(1), this.getPlayerScore(2)] },
        ]
    }

    public state(): IStigmergyState {
        return {
            game: StigmergyGame.gameinfo.uid,
            numplayers: this.numplayers,
            variants: this.variants,
            gameover: this.gameover,
            winner: [...this.winner],
            stack: [...this.stack]
        };
    }

    public moveState(): IMoveState {
        return {
            _version: StigmergyGame.gameinfo.version,
            _results: [...this.results],
            _timestamp: new Date(),
            currplayer: this.currplayer,
            lastmove: this.lastmove,
            board: new Map(this.board),
            scores: [...this.scores],
            buttontaker: this.buttontaker,
            komi: this.komi
        };
    }

    public render(opts?: IRenderOpts): APRenderRep {
        let altDisplay: string | undefined;
        if (opts !== undefined) {
            altDisplay = opts.altDisplay;
        }
        let showThreatened = true;
        let showInfluence = true;
        if (altDisplay !== undefined) {
            if (altDisplay === "hide-threatened") {
                showThreatened = false;
            } else if (altDisplay === "hide-influence") {
                showInfluence = false;
            } else if (altDisplay === "hide-both") {
                showThreatened = false;
                showInfluence = false;
            }
        }

        const legendNames: Set<string> = new Set();
        // A - player1 normal
        // B - player2 normal
        // C - player1 threatened
        // D - player2 threatened

        // Build piece string
        let pstr = "";
        const threatenedPieces: Set<string> = showThreatened ? this.threatenedPieces() : new Set();
        for (const row of this.listCells(true)) {
            if (pstr.length > 0) {
                pstr += "\n";
            }
            let pieces: string[] = [];
            for (const cell of row) {
                if (this.board.has(cell)) {
                    const player = this.board.get(cell)!;
                    let key;
                    if (player === 1) {
                        if (threatenedPieces.has(cell)) {
                            key = "C";
                        } else {
                            key = "A";
                        }
                    } else {
                        if (threatenedPieces.has(cell)) {
                            key = "D";
                        } else {
                            key = "B";
                        }
                    }
                    legendNames.add(key);
                    pieces.push(key);
                } else {
                    pieces.push("-");
                }

            }
            // If all elements are "-", replace with "_"
            if (pieces.every(p => p === "-")) {
                pieces = ["_"];
            }
            pstr += pieces.join(",");
        }

        // build legend based on stack sizes
        const legend: ILooseObj = {};
        for (const piece of legendNames) {
            const player = piece === "A" || piece === "C" ? 1 : 2;
            if (piece === "A" || piece === "B" || piece === "E") {
                legend[piece] = [
                    { name: "piece", player }
                ];
            } else if (piece === "C" || piece === "D") {
                legend[piece] = [
                    { name: "piece-borderless", scale: 1.1, player: player % 2 + 1 },
                    { name: "piece", player }
                ];
            }
        }

        let points1: {row: number, col: number}[] = [];
        let points2: {row: number, col: number}[] = [];
        if (showInfluence) {
            const points = this.influenceMarkers();
            points1 = points.get(1)!;
            points2 = points.get(2)!;
        }
        let markers: Array<any> | undefined = []
        if (points1.length > 0) {
            // @ts-ignore
            markers.push({ type: "flood", colour: 1, opacity: 0.2, points: points1 });
        }
        if (points2.length > 0) {
            // @ts-ignore
            markers.push({ type: "flood", colour: 2, opacity: 0.2, points: points2 });
        }
        if (markers.length === 0) {
            markers = undefined;
        }

        // Build rep
        const rep: APRenderRep =  {
            board: {
                style: "hex-of-hex",
                minWidth: this.boardSize,
                maxWidth: this.boardSize * 2 - 1,
                // @ts-ignore
                markers,
            },
            legend,
            pieces: pstr,
        };

        // Add annotations
        if (this.stack[this.stack.length - 1]._results.length > 0) {
            // @ts-ignore
            rep.annotations = [];
            for (const move of this.stack[this.stack.length - 1]._results) {
                if (move.type === "place") {
                    const [x, y] = this.getGraph().algebraic2coords(move.where!);
                    rep.annotations.push({type: "enter", targets: [{row: y, col: x}]});
                }
            }
        }
        return rep;
    }

    private influenceMarkers(): Map<playerid, {row: number, col: number}[]> {
        // Get cells that are occupied by each player or have equal or greater LOS by each player.
        // Unoccupied cells with equal LOS will be in both groups.
        const markers = new Map<playerid, {row: number, col: number}[]>([
            [1, []],
            [2, []],
        ]);
        for (const cell of this.listCells() as string[]) {
            if (this.board.has(cell)) {
                const player = this.board.get(cell)!;
                const [x, y] = this.getGraph().algebraic2coords(cell);
                const cellCoords = {row: y, col: x};
                markers.get(player)!.push(cellCoords);
            } else {
                const losTarget = Math.floor(this.getGraph().neighbours(cell).length / 2) + 1;
                const player1Los = this.getLosCount(cell, 1);
                const player2Los = this.getLosCount(cell, 2);
                if (player1Los === 0 && player2Los === 0) { continue; }
                const [x, y] = this.getGraph().algebraic2coords(cell);
                const cellCoords = {row: y, col: x};
                if (player1Los >= losTarget) {
                    markers.get(1)!.push(cellCoords);
                }
                if (player2Los >= losTarget) {
                    markers.get(2)!.push(cellCoords);
                }
            }
        }
        return markers;
    }

    private threatenedPieces(): Set<string> {
        // A piece is threatened if it can be captured by the other player.
        const threatenedPieces = new Set<string>();
        for (const cell of this.listCells() as string[]) {
            if (this.board.has(cell)) {
                const losTarget = Math.floor(this.getGraph().neighbours(cell).length / 2) + 1;
                const otherPlayer = this.getOtherPlayer(this.board.get(cell)!);
                const losCount = this.getLosCount(cell, otherPlayer);
                if (losCount >= losTarget) {
                    threatenedPieces.add(cell);
                }
            }
        }
        return threatenedPieces;
    }

    public status(): string {
        let status = super.status();

        if (this.variants !== undefined) {
            status += "**Variants**: " + this.variants.join(", ") + "\n\n";
        }

        status += "**Scores**\n\n";
        for (let n = 1; n <= this.numplayers; n++) {
            const rawScore = this.scores[n-1];
            const pieces = this.pieceCount(n as playerid);
            const influence = rawScore - pieces;
            const score = this.getPlayerScore(n as playerid);
            const bonus = score - rawScore;
            status += `Player ${n}: ${pieces} + ${influence} + ${bonus} = ${score}\n\n`;
        }

        return status;
    }

    public clone(): StigmergyGame {
        return new StigmergyGame(this.serialize());
    }

}
