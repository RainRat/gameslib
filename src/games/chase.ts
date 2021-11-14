import { CompassDirection, defineGrid, extendHex } from "honeycomb-grid";
import { GameBase, IAPGameState, IIndividualState } from "./_base";
import { APGamesInformation } from "../schemas/gameinfo";
import { APRenderRep } from "@abstractplay/renderer/src/schema";
import { APMoveResult } from "../schemas/moveresults";
import { reviver, UserFacingError } from "../common";
import i18next from "i18next";
// tslint:disable-next-line: no-var-requires
const deepclone = require("rfdc/default");

const gameDesc:string = `# Chase

Chase is a unique move and capture game played on a cylindrical hex board with dice. Pieces move the exact number of spaces showing on the die face (it's "speed"). Landing on enemy pieces captures them; landing on friendly pieces bumps them, which can cause chain reactions. The chamber in the centre of the board is a way of gaining more pieces. You must maintain a total of 25 speed throughout the game. Once you are no longer able to do that, you lose.
`;

type playerid = 1|2;
type Speed = 1|2|3|4|5|6;
type CellContents = [playerid, Speed];

interface IMoveState extends IIndividualState {
    currplayer: playerid;
    board: Map<string, CellContents>;
    lastmove?: string;
}

export interface IChaseState extends IAPGameState {
    winner: playerid[];
    stack: Array<IMoveState>;
};

interface IVector {
    vector: [number, number][];
    finalDir: CompassDirection;
}

const columnLabels = "abcdefghijklmnopqrstuvwxyz".split("");
const hexDirs = ["NE", "E", "SE", "SW", "W", "NW"];

const Hex = extendHex({
    offset: 1,
    orientation: "pointy"
});
const hexGrid = defineGrid(Hex).rectangle({width: 9, height: 9});
const leftDirs: Map<CompassDirection, CompassDirection> = new Map([
    ["SW" as CompassDirection, "E" as CompassDirection],
    ["W" as CompassDirection, "SE" as CompassDirection],
    ["NW" as CompassDirection, "S" as CompassDirection],
    ["NE" as CompassDirection, "W" as CompassDirection],
    ["E" as CompassDirection, "NW" as CompassDirection],
    ["SE" as CompassDirection, "NE" as CompassDirection]
]);
const rightDirs: Map<CompassDirection, CompassDirection> = new Map([
    ["SW" as CompassDirection, "NW" as CompassDirection],
    ["W" as CompassDirection, "NE" as CompassDirection],
    ["NW" as CompassDirection, "E" as CompassDirection],
    ["NE" as CompassDirection, "SE" as CompassDirection],
    ["E" as CompassDirection, "SW" as CompassDirection],
    ["SE" as CompassDirection, "W" as CompassDirection]
]);
const chamberExits: Map<CompassDirection, [string, string]> = new Map([
    ["SW" as CompassDirection, ["e6", "f5"]],
    ["W" as CompassDirection, ["d6", "f6"]],
    ["NW" as CompassDirection, ["d5", "e6"]],
    ["NE" as CompassDirection, ["e4", "d6"]],
    ["E" as CompassDirection, ["f5", "d5"]],
    ["SE" as CompassDirection, ["f6", "e4"]]
]);

export class ChaseGame extends GameBase {
    public static readonly gameinfo: APGamesInformation = {
        name: "Chase",
        uid: "chase",
        playercounts: [2],
        version: "20211009",
        description: gameDesc,
        urls: ["https://en.wikipedia.org/wiki/Chase_(board_game)", "https://boardgamegeek.com/boardgame/316/chase"],
        people: [
            {
                type: "designer",
                name: "Tom Krusezewski"
            },
            {
                type: "publisher",
                name: "TSR"
            }
        ]
    };
    public static coords2algebraic(x: number, y: number): string {
        return columnLabels[9 - y - 1] + (x + 1).toString();
    }

    public static algebraic2coords(cell: string): [number, number] {
        const pair: string[] = cell.split("");
        const num = (pair.slice(1)).join("");
        const y = columnLabels.indexOf(pair[0]);
        if ( (y === undefined) || (y < 0) ) {
            throw new Error(`The column label is invalid: ${pair[0]}`);
        }
        const x = parseInt(num, 10);
        if ( (x === undefined) || (isNaN(x)) ) {
            throw new Error(`The row label is invalid: ${pair[1]}`);
        }
        return [x - 1, 9 - y - 1];
    }

    /**
     * Returns the list of hexes a piece would pass through from the given start space,
     * in the given direction, at the given speed. Takes into consideration wraparound and richochets.
     * Does not include the start cell in the returned list, nor does it do any validation.
     * The `moves` function has to make sure the movement rules are ultimately followed.
     *
     * @private
     * @param {number} x
     * @param {number} y
     * @param {Directions} dir
     * @param {number} distance
     * @returns {[number, number][]}
     * @memberof ChaseGame
     */
     public static vector(x: number, y: number, dir: CompassDirection, distance: number = 1): IVector {
        if (! hexDirs.includes(dir)) {
            throw new Error(`Invalid direction passed for a pointy hex: ${dir}`);
        }
        if ( (x < 0) || (x >= 9) || (y < 0) || (y >= 9) ) {
            throw new Error(`Invalid coordinates for a Chase board: ${x},${y}`);
        }
        if ( (distance < 0) || (distance > 6) ) {
            throw new Error(`Invalid distance for a Chase game: ${distance}`);
        }
        const cells: [number, number][] = [];
        let hex = hexGrid.get([x, y]);
        if (hex === undefined) {
            throw new Error(`Invalid starting hex ${x},${y}`);
        }
        while (distance > 0) {
            // First use the library to find a neighbour
            // If it's valid, we're good.
            const neighbours = hexGrid.neighborsOf(hex!, dir);
            if ( (neighbours !== undefined) && (Array.isArray(neighbours)) && (neighbours.filter(n => n !== undefined).length === 1) ) {
                hex = neighbours.filter(n => n !== undefined)[0];
                cells.push([hex.x, hex.y]);
            // Otherwise, check for richochet (have to check for richochet before wraparound or things break)
            } else if ( (hex.y === 0) && (dir === "NE") ) {
                hex = hexGrid.get([(hex.x + 1) % 9, hex.y + 1]);
                if (hex === undefined) {
                    throw new Error("Error calculating richochet NE from row 0.");
                }
                cells.push([hex!.x, hex!.y]);
                dir = "SE" as CompassDirection;
            } else if ( (hex.y === 0) && (dir === "NW") ) {
                hex = hexGrid.get([hex.x, hex.y + 1]);
                if (hex === undefined) {
                    throw new Error("Error calculating richochet NW from row 0.");
                }
                cells.push([hex!.x, hex!.y]);
                dir = "SW" as CompassDirection;
            } else if ( (hex.y === 8) && (dir === "SE") ) {
                hex = hexGrid.get([(hex.x + 1) % 9, hex.y - 1]);
                if (hex === undefined) {
                    throw new Error("Error calculating richochet SE from row 8.");
                }
                cells.push([hex!.x, hex!.y]);
                dir = "NE" as CompassDirection;
            } else if ( (hex.y === 8) && (dir === "SW") ) {
                hex = hexGrid.get([hex.x, hex.y - 1]);
                if (hex === undefined) {
                    throw new Error("Error calculating richochet SW from row 8.");
                }
                cells.push([hex!.x, hex!.y]);
                dir = "NW" as CompassDirection;
            // Then check for wraparound
            } else if ( (hex.x === 0) && (dir === "W") ) {
                hex = hexGrid.get([8, hex.y]);
                if (hex === undefined) {
                    throw new Error("Error calculating wraparound W from column 0.");
                }
                cells.push([hex!.x, hex!.y])
            } else if ( (hex.x === 0) && (dir === "NW") ) {
                hex = hexGrid.get([8, hex.y - 1]);
                if (hex === undefined) {
                    throw new Error("Error calculating wraparound NW from column 0.");
                }
                cells.push([hex!.x, hex!.y])
            } else if ( (hex.x === 0) && (dir === "SW") ) {
                hex = hexGrid.get([8, hex.y + 1]);
                if (hex === undefined) {
                    throw new Error("Error calculating wraparound SW from column 0.");
                }
                cells.push([hex!.x, hex!.y])
            } else if ( (hex.x === 8) && (dir === "E") ) {
                hex = hexGrid.get([0, hex.y]);
                if (hex === undefined) {
                    throw new Error("Error calculating wraparound E from column 8.");
                }
                cells.push([hex!.x, hex!.y]);
            } else if ( (hex.x === 8) && (dir === "NE") ) {
                hex = hexGrid.get([0, hex.y - 1]);
                if (hex === undefined) {
                    throw new Error("Error calculating wraparound NE from column 8.");
                }
                cells.push([hex!.x, hex!.y]);
            } else if ( (hex.x === 8) && (dir === "SE") ) {
                hex = hexGrid.get([0, hex.y + 1]);
                if (hex === undefined) {
                    throw new Error("Error calculating wraparound SE from column 8.");
                }
                cells.push([hex!.x, hex!.y]);
            } else {
                throw new Error(`Something went horribly wrong while calculating a movement vector. This should never happen.\nStart: ${x},${y}, Curr: ${hex}, Dir: ${dir}, Distance: ${distance}`);
            }
            distance--;
        }
        return {
            vector: cells,
            finalDir: dir
        };
    }

    public numplayers: number = 2;
    public currplayer!: playerid;
    public board!: Map<string, CellContents>;
    public lastmove?: string;
    public gameover: boolean = false;
    public winner: playerid[] = [];
    public stack!: Array<IMoveState>;
    public results: Array<APMoveResult> = [];
    public variants: string[] = [];

    constructor(state?: IChaseState | string) {
        super();
        if (state !== undefined) {
            if (typeof state === "string") {
                state = JSON.parse(state, reviver) as IChaseState;
            }
            if (state.game !== ChaseGame.gameinfo.uid) {
                throw new Error(`The Chase game code cannot process a game of '${state.game}'.`);
            }
            this.gameover = state.gameover;
            this.winner = [...state.winner];
            this.stack = [...state.stack];
        } else {
            const fresh: IMoveState = {
                _version: ChaseGame.gameinfo.version,
                _results: [],
                currplayer: 1,
                board: new Map([
                    ["a1", [1, 1]],
                    ["a2", [1, 2]],
                    ["a3", [1, 3]],
                    ["a4", [1, 4]],
                    ["a5", [1, 5]],
                    ["a6", [1, 4]],
                    ["a7", [1, 3]],
                    ["a8", [1, 2]],
                    ["a9", [1, 1]],
                    ["i1", [2, 1]],
                    ["i2", [2, 2]],
                    ["i3", [2, 3]],
                    ["i4", [2, 4]],
                    ["i5", [2, 5]],
                    ["i6", [2, 4]],
                    ["i7", [2, 3]],
                    ["i8", [2, 2]],
                    ["i9", [2, 1]],
                ])
            };
            this.stack = [fresh];
        }
        this.load();
    }

    public load(idx: number = -1): ChaseGame {
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
        this.board = deepclone(state.board);
        this.lastmove = state.lastmove;
       return this;
    }

    public moves(player?: playerid): string[] {
        if (player === undefined) {
            player = this.currplayer;
        }
        if (this.gameover) {return [];}

        const moves: string[] = [];

        // Balancing moves always first
        const balanceMoves: string[][] = this.recurseBalance(player);

        if (balanceMoves.length > 0) {
            // For each balance move, execute it and then check for other moves
            for (const balances of balanceMoves) {
                const cloned: ChaseGame = Object.assign(new ChaseGame(), deepclone(this));
                const playerPieces = [...cloned.board.entries()].filter(e => e[1][0] === player);
                const speed: number = playerPieces.map(p => p[1][1] as number).reduce((a, b) => a + b);
                let delta  = 25 - speed;
                for (const cell of balances) {
                    const piece = cloned.board.get(cell);
                    if (piece![1] + delta > 6) {
                        delta -= 6 - piece![1];
                        piece![1] = 6;
                    } else {
                        piece![1] += delta;
                        delta = 0;
                    }
                }
                const bstr = "{" + balances.join(",") + "}";
                moves.push(...cloned.movesExchanges(player).map(m => bstr + m));
                moves.push(...cloned.movesMoves(player).map(m => bstr + m));
            }
        } else {
            // If speed is not 25, then we're done
            const playerPieces = [...this.board.entries()].filter(e => e[1][0] === player).sort((a, b) => a[1][1] - b[1][1]);
            const speed: number = playerPieces.map(p => p[1][1] as number).reduce((a, b) => a + b);
            if (speed === 25) {
                moves.push(...this.movesExchanges(player));
                moves.push(...this.movesMoves(player));
            }
        }

        return moves;
    }

    private movesExchanges(player: playerid): string[] {
        const moves: string[] = [];
        const playerPieces = [...this.board.entries()].filter(e => e[1][0] === player);
        for (const piece of playerPieces) {
            const [x, y] = ChaseGame.algebraic2coords(piece[0]);
            const neighbours: [number,number][] = [];
            if ( (x === 0) || (x === 8) ) {
                // manually look for neighbours to account for wraparound, accounting for duplicates
                const possible: Set<string> = new Set();
                for (const dir of ["NE", "E", "SE", "SW", "W", "NW"] as const) {
                    const v = ChaseGame.vector(x, y, dir as CompassDirection).vector;
                    if (v.length !== 1) {
                        throw new Error("Something went wrong finding a neighbour cell.");
                    }
                    possible.add(`${v[0][0]},${v[0][1]}`);
                }
                neighbours.push(...[...possible.values()].map(v => v.split(",").map(n => parseInt(n, 10))).map(p => [p[0], p[1]] as [number, number]));
            } else {
                // otherwise, just use the library function
                neighbours.push(...hexGrid.neighborsOf(Hex(x, y)).filter(h => h !== undefined).map(h => [h.x, h.y] as [number,number]));
            }
            for (const n of neighbours) {
                const exs: [string, number][][] = [];
                const nCell = ChaseGame.coords2algebraic(...n);
                if (this.board.has(nCell)) {
                    const nPiece = this.board.get(nCell);
                    if (nPiece![0] === player) {
                        // add first
                        let aSpeed = piece[1][1];
                        let bSpeed = nPiece![1];
                        while (aSpeed < 6) {
                            aSpeed++;
                            bSpeed--;
                            if ( (aSpeed <= 6) && (bSpeed > 0) ) {
                                exs.push([[piece[0], aSpeed], [nCell, bSpeed]]);
                            }
                        }
                        // then subtract
                        aSpeed = piece[1][1];
                        bSpeed = nPiece![1];
                        while (aSpeed > 1) {
                            aSpeed--;
                            bSpeed++;
                            if ( (aSpeed > 0) && (bSpeed <= 6) ) {
                                exs.push([[piece[0], aSpeed], [nCell, bSpeed]]);
                            }
                        }
                    }
                }
                moves.push(...exs.map(e => e.map(half => half.join("=")).join(",")));
            }
        }
        return moves;
    }

    private movesMoves(player: playerid): string[] {
        const moves: string[] = [];
        const playerPieces = [...this.board.entries()].filter(e => e[1][0] === player);
        for (const piece of playerPieces) {
            const start = piece[0];
            const [startX, startY] = ChaseGame.algebraic2coords(start);
            const speed = piece[1][1];
            for (const dir of ["NE", "E", "SE", "SW", "W", "NW"] as const) {
                // Skip silly ricochets of pieces starting at board ends
                if ( ( (startY === 0) && (dir === "NE") ) ||
                     ( (startY === 0) && (dir === "NW") ) ||
                     ( (startY === 8) && (dir === "SE") ) ||
                     ( (startY === 8) && (dir === "SW") ) ) {
                    continue;
                }
                const v = ChaseGame.vector(startX, startY, dir as CompassDirection, speed).vector;
                // Make sure intermediate spaces are clear
                const middle = v.slice(0, v.length - 1);
                let valid = true;
                for (const mid of middle) {
                    const midCell = ChaseGame.coords2algebraic(...mid);
                    if ( (midCell === "e5") || (this.board.has(midCell)) ) {
                        valid = false;
                        break;
                    }
                }
                if (valid) {
                    const final = v[v.length - 1];
                    const finalCell = ChaseGame.coords2algebraic(...final);
                    // if final cell is empty, it's a move
                    if (! this.board.has(finalCell)) {
                        moves.push(`${start}-${finalCell}${dir}`);
                    } else {
                        const occ = this.board.get(finalCell);
                        // If occupied by friendly, it's a move
                        if (occ![0] === player) {
                            moves.push(`${start}-${finalCell}${dir}`);
                        // otherwise it's a capture
                        } else {
                            moves.push(`${start}x${finalCell}${dir}`);
                        }
                    }
                }
            }
        }
        return moves;
    }

    private recurseBalance(player: playerid, sofar: string[] = []): string[][] {
        const moves: string[][] = []
        const playerPieces = [...this.board.entries()].filter(e => e[1][0] === player).sort((a, b) => a[1][1] - b[1][1]);
        const speed: number = playerPieces.map(p => p[1][1] as number).reduce((a, b) => a + b);
        if ( (speed < 25) && (playerPieces.length > 4) ) {
            const delta = 25 - speed;
            const lowest: number = playerPieces[0][1][1];
            const allLowest = playerPieces.filter(p => p[1][1] === lowest);
            for (const l of allLowest) {
                if (l[1][1] + delta <= 6) {
                    moves.push([...sofar, l[0]])
                } else {
                    const clone = Object.assign(new ChaseGame(), deepclone(this));
                    const piece = clone.board.get(l[0]);
                    piece![1] = 6;
                    moves.push(...clone.recurseBalance(player, [...sofar, l[0]]))
                }
            }
        }
        return moves;
    }

    public randomMove(): string {
        const moves = this.moves();
        return moves[Math.floor(Math.random() * moves.length)];
    }

    // These click handlers will need adjusting to handle the complicated notation
    public click(row: number, col: number, piece: string): string {
        return ChaseGame.coords2algebraic(col, row);
    }

    public clicked(move: string, coord: string): string {
        if (move.length > 0 && move.length < 5)
            return move + '-' + coord;
        else if (move.length >= 5 && move.length < 8)
            return move + '/' + coord;
        else
            return coord;
    }

    public move(m: string): ChaseGame {
        if (this.gameover) {
            throw new UserFacingError("MOVES_GAMEOVER", i18next.t("apgames:MOVES_GAMEOVER"));
        }
        // Normalize
        m = m.toLowerCase();
        m = m.replace(/\s+/g, "");
        m = m.replace(/\([a-z]+\)$/, (match) => {return match.toUpperCase();});
        const moves = this.moves();
        if (! moves.includes(m)) {
            // Check to see if the direction just wasn't specified because it wasn't necessary
            const check = moves.filter(x => x.startsWith(m));
            if (check.length === 1) {
                m = check[0];
            } else {
                throw new UserFacingError("MOVES_INVALID", i18next.t("apgames:MOVES_INVALID"));
            }
        }
        let working = m;
        this.results = [];

        // Move valid, so change the state
        // Look for balancing moves first
        if (working.startsWith("{")) {
            const match = working.match(/^{(\S+)}/);
            if (match === null) {
                throw new Error("Could not extract balance information.");
            }
            const balances = match[1].split(",");
            const playerPieces = [...this.board.entries()].filter(e => e[1][0] === this.currplayer);
            const speed: number = playerPieces.map(p => p[1][1] as number).reduce((a, b) => a + b);
            let delta  = 25 - speed;
            for (const cell of balances) {
                const piece = this.board.get(cell);
                if (piece![1] + delta > 6) {
                    this.results.push({type: "convert", what: piece![1].toString(), into: "6", where: cell});
                    delta -= 6 - piece![1];
                    piece![1] = 6;
                } else {
                    this.results.push({type: "convert", what: piece![1].toString(), into: (piece![1] + delta).toString(), where: cell});
                    piece![1] += delta;
                    delta = 0;
                }
            }
            if (delta !== 0) {
                throw new Error("Something went horribly wrong balancing speed.");
            }
            working = working.replace(match[0], "");
        }

        // Exchanges next
        if (working.includes("=")) {
            const [left, right] = working.split(",");
            const [lcell, lval] = left.split("=");
            const [rcell, rval] = right.split("=");
            if ( (! this.board.has(lcell)) || (! this.board.has(rcell)) ) {
                throw new Error("Attempting to exchange between unoccupied cells.");
            }
            if ( (isNaN(parseInt(lval, 10))) || (isNaN(parseInt(rval, 10))) ) {
                throw new Error("Invalid exchange values encountered.");
            }
            const lpiece = this.board.get(lcell);
            const rpiece = this.board.get(rcell);
            this.results.push(
                {type: "convert", what: lpiece![1].toString(), into: lval, where: lcell},
                {type: "convert", what: rpiece![1].toString(), into: rval, where: rcell},
            );
            lpiece![1] = parseInt(lval, 10) as Speed;
            rpiece![1] = parseInt(rval, 10) as Speed;
        // otherwise, movement/capture
        } else {
            const match = working.match(/^([a-z][0-9])[-x]([a-z][0-9])([NESW]+)$/);
            if (match === null) {
                throw new Error("Error occurred extracting the various parts of the move.");
            }
            const from = match[1];
            const to = match[2];
            const dir = match[3];
            const [xFrom, yFrom] = ChaseGame.algebraic2coords(from);
            const [xTo, yTo] = ChaseGame.algebraic2coords(to);
            const pFrom = this.board.get(from);
            if (pFrom === undefined) {
                throw new Error("Could not find the piece on the board");
            }
            // Reconstruct the move vector so you can show each step in the movement, for clarity
            const {vector: v, finalDir} = ChaseGame.vector(xFrom, yFrom, dir as CompassDirection, pFrom[1]);
            if ( (v[v.length - 1][0] !== xTo) || (v[v.length - 1][1] !== yTo) ) {
                throw new Error(`Could not reconstruct movement vector.\nMove: ${m}, From: ${from}, xFrom: ${xFrom}, yFrom: ${yFrom}, To: ${to}, Dir: ${dir}, Dist: ${pFrom[1]}, V: ${v.join("|")}\nState: ${this.serialize()}`);
            }
            for (let i = 0; i < v.length; i++) {
                const cell = v[i];
                let prevx = xFrom;
                let prevy = yFrom;
                if (i > 0) {
                    [prevx, prevy] = v[i-1];
                }
                this.results.push({type: "move", from: ChaseGame.coords2algebraic(prevx, prevy), to: ChaseGame.coords2algebraic(...cell)});
                // if ( (Math.abs(prevx - cell[0]) <= 1) && (Math.abs(prevy - cell[1]) <= 1) ) {
            }

            // Create a stack of moves to account for chain reactions
            // The first piece has to be picked up to avoid an infinite loop
            this.board.delete(from);
            this.recurseMove(to, [...pFrom], finalDir);
        }

        this.lastmove = m;
        if (this.currplayer === 1) {
            this.currplayer = 2;
        } else {
            this.currplayer = 1;
        }

        this.checkEOG();
        this.saveState();
        return this;
    }

    // Handle chamber moves here
    private recurseMove(cell: string, piece: CellContents, dir: CompassDirection) {
        // Captures and bumps
        if (this.board.has(cell)) {
            const nPiece = this.board.get(cell);
            // If it doesn't belong to us, we're done
            // Remove the piece, and exit, which will lead to applying the stack
            if (nPiece![0] !== this.currplayer) {
                this.board.delete(cell);
                this.results.push({type: "capture", what: nPiece![1].toString(), where: cell});
                this.board.set(cell, piece);
            // Otherwise, recurse
            } else {
                this.board.set(cell, piece);
                const result: APMoveResult = {type: "eject", what: nPiece![1].toString(), from: cell, to: ""};
                const [x, y] = ChaseGame.algebraic2coords(cell);
                const {vector: chainv, finalDir: d} = ChaseGame.vector(x, y, dir);
                const [xNext, yNext] = chainv[0];
                const cellNext = ChaseGame.coords2algebraic(xNext, yNext);
                result.to = cellNext;
                this.results.push(result);
                this.recurseMove(cellNext, [...nPiece!], d);
            }
        // Chamber moves
        } else if (cell === "e5") {
            const [lcell, rcell] = chamberExits.get(dir)!;
            // If the player already has 10 pieces (9, actually, because we're in the middle of a move), just eject the piece
            if ([...this.board.values()].filter(p => p[0] === this.currplayer).length === 9) {
                this.results.push({type: "move", from: "e5", to: lcell});
                this.recurseMove(lcell, [...piece], leftDirs.get(dir)!)
            // If it's a 1, just eject the piece
            } else if (piece[1] === 1) {
                this.results.push({type: "move", from: "e5", to: lcell});
                this.recurseMove(lcell, [...piece], leftDirs.get(dir)!)
            // Otherwise, split and eject
            } else {
                const currSpeed = piece[1]!;
                const lspeed = Math.ceil(currSpeed / 2);
                const rspeed = Math.floor(currSpeed / 2);
                this.results.push(
                    {type: "take", what: currSpeed.toString(), from: "e5"},
                    {type: "place", what: lspeed.toString(), where: lcell},
                    {type: "place", what: rspeed.toString(), where: rcell},
                );
                this.recurseMove(lcell, [this.currplayer, lspeed] as CellContents, leftDirs.get(dir)!);
                this.recurseMove(rcell, [this.currplayer, rspeed] as CellContents, rightDirs.get(dir)!);
            }
        // Regular move
        } else {
            this.board.set(cell, piece);
        }
    }

    protected checkEOG(): ChaseGame {
        if (this.moves().length === 0) {
            this.gameover = true;
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

    public resign(player: 1|2): ChaseGame {
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

    public state(): IChaseState {
        return {
            game: ChaseGame.gameinfo.uid,
            numplayers: 2,
            variants: [],
            gameover: this.gameover,
            winner: [...this.winner],
            stack: [...this.stack]
        };
    }

    protected moveState(): IMoveState {
        return {
            _version: ChaseGame.gameinfo.version,
            _results: [...this.results],
            currplayer: this.currplayer,
            lastmove: this.lastmove,
            board: deepclone(this.board)
        };
    }

    public render(): APRenderRep {
        // Build piece string
        const pieces: string[][] = [];
        const letters: string = "AB";
        for (let row = 0; row < 9; row++) {
            const node: string[] = [];
            for (let col = 0; col < 9; col++) {
                const cell = ChaseGame.coords2algebraic(col, row);
                if (cell === "e5") {
                    node.push("X");
                } else if (this.board.has(cell)) {
                    const [owner, speed] = this.board.get(cell)!;
                    node.push(`${letters[owner - 1]}${speed}`);
                } else {
                    node.push("");
                }
            }
            pieces.push(node);
        }
        let pstr: string = pieces.map(r => r.join(",")).join("\n");
        pstr = pstr.replace(/\n,{8}\n/g, "\n_\n");

        // Build rep
        const rep: APRenderRep =  {
            board: {
                style: "hex-even-p",
                width: 9,
                height: 9
            },
            legend: {
                A1: {
                    name: "d6-1",
                    player: 1
                },
                A2: {
                    name: "d6-2",
                    player: 1
                },
                A3: {
                    name: "d6-3",
                    player: 1
                },
                A4: {
                    name: "d6-4",
                    player: 1
                },
                A5: {
                    name: "d6-5",
                    player: 1
                },
                A6: {
                    name: "d6-6",
                    player: 1
                },
                B1: {
                    name: "d6-1",
                    player: 2
                },
                B2: {
                    name: "d6-2",
                    player: 2
                },
                B3: {
                    name: "d6-3",
                    player: 2
                },
                B4: {
                    name: "d6-4",
                    player: 2
                },
                B5: {
                    name: "d6-5",
                    player: 2
                },
                B6: {
                    name: "d6-6",
                    player: 2
                },
                X: {
                    name: "piecepack-number-void",
                    colour: "#000"
                }
            },
            pieces: pstr
        };

        // Add annotations
        if (this.stack[this.stack.length - 1]._results.length > 0) {
            // @ts-ignore
            rep.annotations = [];
            for (const move of this.stack[this.stack.length - 1]._results) {
                if (move.type === "move") {
                    const [fromX, fromY] = ChaseGame.algebraic2coords(move.from);
                    const [toX, toY] = ChaseGame.algebraic2coords(move.to);
                    rep.annotations!.push({type: "move", arrow: false, targets: [{row: fromY, col: fromX}, {row: toY, col: toX}]});
                } else if (move.type === "eject") {
                    const [fromX, fromY] = ChaseGame.algebraic2coords(move.from);
                    const [toX, toY] = ChaseGame.algebraic2coords(move.to);
                    rep.annotations!.push({type: "eject", targets: [{row: fromY, col: fromX}, {row: toY, col: toX}]});
                } else if (move.type === "place") {
                    const [x, y] = ChaseGame.algebraic2coords(move.where!);
                    rep.annotations!.push({type: "enter", targets: [{row: y, col: x}]});
                } else if (move.type === "capture") {
                    const [x, y] = ChaseGame.algebraic2coords(move.where!);
                    rep.annotations!.push({type: "exit", targets: [{row: y, col: x}]});
                } else if (move.type === "convert") {
                    const [x, y] = ChaseGame.algebraic2coords(move.where!);
                    rep.annotations!.push({type: "enter", targets: [{row: y, col: x}]});
                }
            }
        }

        return rep;
    }

    public status(): string {
        let status = super.status();

        const playerPieces = [...this.board.entries()].filter(e => e[1][0] === this.currplayer).sort((a, b) => a[1][1] - b[1][1]);
        const speed: number = playerPieces.map(p => p[1][1] as number).reduce((a, b) => a + b);
        if (speed < 25) {
            const delta = 25 - speed;
            status += `**Current player is imbalanced by ${delta} speed.**\n\n`;
        }

        return status;
    }

    public chatLog(players: string[]): string[][] {
        // eog, resign, winners, convert, capture, eject, move, take, place
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

                const moves = state._results.filter(r => r.type === "move");
                if (moves.length > 0) {
                    const first = moves[0];
                    const last = moves[moves.length - 1];
                    const rest = moves.slice(0, moves.length - 1);
                    if ( moves.length > 2) {
                        // @ts-ignore
                        node.push(i18next.t("apresults:MOVE.chase", {player: name, from: first.from, to: last.to, through: rest.map(r => r.to).join(", ")}));
                    } else {
                        // @ts-ignore
                        node.push(i18next.t("apresults:MOVE.nowhat", {player: name, from: first.from, to: last.to}));
                    }
                }
                for (const r of state._results) {
                    switch (r.type) {
                        case "capture":
                            node.push(i18next.t("apresults:CAPTURE.complete", {player: name, what: r.what, where: r.where}));
                            break;
                        case "eject":
                            node.push(i18next.t("apresults:MOVE.push", {what: r.what, from: r.from, to: r.to}));
                            break;
                        case "convert":
                            node.push(i18next.t("apresults:CONVERT.complete", {player: name, what: r.what, into: r.into, where: r.where}));
                            break;
                        case "take":
                            node.push(i18next.t("apresults:TAKE.chase", {what: r.what}));
                            break;
                        case "place":
                            node.push(i18next.t("apresults:PLACE.chase", {what: r.what, where: r.where}));
                            break;
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

    public clone(): ChaseGame {
        return new ChaseGame(this.serialize());
    }
}
