import "mocha";
import { expect } from "chai";
import {
    GasQueue,
    GasQueueItem,
    GasQueueItemRequest,
    PisaTransactionIdentifier
} from "../../../src/responder/gasQueue";
import { ArgumentError, IEthereumResponseData } from "../../../src/dataEntities";
import { BigNumber } from "ethers/utils";

const createIdentifier = (data: string, to: string) => {
    return new PisaTransactionIdentifier(1, data, to, new BigNumber(0), new BigNumber(500));
};

const createResponseData = (): IEthereumResponseData => {
    return {
        contractAbi: "abi",
        contractAddress: "address",
        functionArgs: [],
        functionName: "fnName",
        endBlock: 10
    };
};

const createGasQueueItem = (
    nonce: number,
    idealGasPrice: BigNumber,
    currentGasPrice: BigNumber,
    identifier: PisaTransactionIdentifier
) => {
    return new GasQueueItem(
        new GasQueueItemRequest(identifier, idealGasPrice, createResponseData()),
        currentGasPrice,
        idealGasPrice,
        nonce
    );
};

describe("GasQueueItem", () => {
    it("constructor", () => {
        createGasQueueItem(1, new BigNumber(10), new BigNumber(10), createIdentifier("data", "to"));
    });

    it("constructor does not accept current gas less than ideal gas", () => {
        expect(() =>
            createGasQueueItem(1, new BigNumber(10), new BigNumber(9), createIdentifier("data", "to"))
        ).to.throw(ArgumentError);
    });
});

describe("GasQueue", () => {
    it("constructor accepts empty array", () => {
        new GasQueue([], 0, 1, 1);
    });

    it("constructor throws for negative nonce", () => {
        expect(() => new GasQueue([], -1, 1, 1)).to.throw(ArgumentError);
    });

    it("constructor throws for too low replacement rate", () => {
        expect(() => new GasQueue([], 1, 0.9, 1)).to.throw(ArgumentError);
    });

    it("constructor throws for 0 max queue depth", () => {
        expect(() => new GasQueue([], 1, 1, 0)).to.throw(ArgumentError);
    });

    it("constructor can contain items", () => {
        const items = [createGasQueueItem(1, new BigNumber(10), new BigNumber(10), createIdentifier("data", "to"))];
        new GasQueue(items, 2, 1, 1);
    });

    it("constructor emptyNonce must be last item nonce plus one", () => {
        const items = [createGasQueueItem(1, new BigNumber(10), new BigNumber(10), createIdentifier("data", "to"))];
        expect(() => new GasQueue(items, 3, 1, 1)).to.throw(ArgumentError);
    });

    it("constructor items cannot be more than max depth", () => {
        const items = [
            createGasQueueItem(1, new BigNumber(10), new BigNumber(10), createIdentifier("data", "to")),
            createGasQueueItem(2, new BigNumber(9), new BigNumber(9), createIdentifier("data1", "to1"))
        ];
        expect(() => new GasQueue(items, 3, 1, 1)).to.throw(ArgumentError);
    });

    it("constructor does accept multiple items", () => {
        const items = [
            createGasQueueItem(1, new BigNumber(10), new BigNumber(10), createIdentifier("data", "to")),
            createGasQueueItem(2, new BigNumber(9), new BigNumber(9), createIdentifier("data1", "to1"))
        ];
        new GasQueue(items, 3, 1, 2);
    });

    it("constructor does not accept multiple items with same identifier", () => {
        const items = [
            createGasQueueItem(1, new BigNumber(10), new BigNumber(10), createIdentifier("data", "to")),
            createGasQueueItem(2, new BigNumber(9), new BigNumber(9), createIdentifier("data", "to"))
        ];
        expect(() => new GasQueue(items, 3, 1, 2)).to.throw(ArgumentError);
    });

    it("constructor does accept multiple items with the same ideal gas and current gas", () => {
        const items = [
            createGasQueueItem(1, new BigNumber(10), new BigNumber(10), createIdentifier("data", "to")),
            createGasQueueItem(2, new BigNumber(9), new BigNumber(9), createIdentifier("data1", "to1"))
        ];
        new GasQueue(items, 3, 1, 2);
    });

    it("constructor item nonce must increase by 1", () => {
        let items = [
            createGasQueueItem(1, new BigNumber(10), new BigNumber(10), createIdentifier("data", "to")),
            createGasQueueItem(3, new BigNumber(9), new BigNumber(9), createIdentifier("data1", "to1"))
        ];
        expect(() => new GasQueue(items, 3, 1, 2)).to.throw(ArgumentError);

        items = [
            createGasQueueItem(1, new BigNumber(10), new BigNumber(10), createIdentifier("data", "to")),
            createGasQueueItem(1, new BigNumber(9), new BigNumber(9), createIdentifier("data1", "to1"))
        ];
        expect(() => new GasQueue(items, 3, 1, 2)).to.throw(ArgumentError);
    });

    it("constructor item gas price cannot increase", () => {
        const items = [
            createGasQueueItem(1, new BigNumber(10), new BigNumber(14), createIdentifier("data", "to")),
            createGasQueueItem(2, new BigNumber(11), new BigNumber(13), createIdentifier("data1", "to1"))
        ];
        expect(() => new GasQueue(items, 3, 1, 2)).to.throw(ArgumentError);
    });

    it("constructor items current gas price can decrease", () => {
        const items = [
            createGasQueueItem(1, new BigNumber(10), new BigNumber(12), createIdentifier("data", "to")),
            createGasQueueItem(2, new BigNumber(9), new BigNumber(13), createIdentifier("data1", "to1"))
        ];
        new GasQueue(items, 3, 1, 2);
    });

    it("add does append for lowest gas", () => {
        const emptyNonce = 3;
        const maxQueueDepth = 5;
        const replacementRate = 15;

        const items = [
            createGasQueueItem(1, new BigNumber(10), new BigNumber(12), createIdentifier("data", "to")),
            createGasQueueItem(2, new BigNumber(9), new BigNumber(11), createIdentifier("data1", "to1"))
        ];
        const request = new GasQueueItemRequest(
            createIdentifier("data2", "to2"),
            new BigNumber(8),
            createResponseData()
        );

        const queue = new GasQueue(items, emptyNonce, replacementRate, maxQueueDepth);
        const appendedQueue = queue.add(request);

        expect(appendedQueue.emptyNonce).to.equal(emptyNonce + 1);
        expect(appendedQueue.maxQueueDepth).to.equal(maxQueueDepth);
        expect(appendedQueue.replacementRate).to.equal(replacementRate);

        expect(appendedQueue.queueItems[2].nonce).to.equal(3);
        expect(appendedQueue.queueItems[2].request).to.equal(request);
        expect(appendedQueue.queueItems[2].idealGasPrice).to.equal(request.idealGasPrice);
        expect(appendedQueue.queueItems[2].currentGasPrice).to.equal(request.idealGasPrice);
    });

    const replacedGasPrice = (rate: number, currentGasPrice: BigNumber) => {
        const rRate = new BigNumber(rate).add(100);
        return currentGasPrice.mul(rRate).div(100);
    };

    it("add does replace for middle gas", () => {
        const emptyNonce = 4;
        const maxQueueDepth = 5;
        const replacementRate = 15;
        const items = [
            createGasQueueItem(1, new BigNumber(150), new BigNumber(150), createIdentifier("data", "to")),
            createGasQueueItem(2, new BigNumber(100), new BigNumber(100), createIdentifier("data1", "to1")),
            createGasQueueItem(3, new BigNumber(80), new BigNumber(80), createIdentifier("data2", "to2"))
        ];
        const request = new GasQueueItemRequest(
            createIdentifier("data3", "to3"),
            new BigNumber(110),
            createResponseData()
        );

        const queue = new GasQueue(items, emptyNonce, replacementRate, maxQueueDepth);
        const appendedQueue = queue.add(request);

        expect(appendedQueue.emptyNonce).to.equal(emptyNonce + 1);
        expect(appendedQueue.maxQueueDepth).to.equal(maxQueueDepth);
        expect(appendedQueue.replacementRate).to.equal(replacementRate);

        expect(appendedQueue.queueItems[1].nonce).to.equal(2);
        expect(appendedQueue.queueItems[1].request).to.equal(request);
        expect(appendedQueue.queueItems[1].idealGasPrice).to.equal(request.idealGasPrice);
        expect(appendedQueue.queueItems[1].currentGasPrice.toNumber()).to.equal(
            replacedGasPrice(replacementRate, new BigNumber(100)).toNumber()
        );

        expect(appendedQueue.queueItems[2].nonce).to.equal(3);
        expect(appendedQueue.queueItems[2].request).to.equal(queue.queueItems[1].request);
        expect(appendedQueue.queueItems[2].idealGasPrice).to.equal(queue.queueItems[1].idealGasPrice);
        expect(appendedQueue.queueItems[2].currentGasPrice.toNumber()).to.equal(
            queue.queueItems[1].currentGasPrice.toNumber()
        );

        expect(appendedQueue.queueItems[3].nonce).to.equal(4);
        expect(appendedQueue.queueItems[3].request).to.equal(queue.queueItems[2].request);
        expect(appendedQueue.queueItems[3].idealGasPrice).to.equal(queue.queueItems[2].idealGasPrice);
        expect(appendedQueue.queueItems[3].currentGasPrice.toNumber()).to.equal(
            queue.queueItems[2].currentGasPrice.toNumber()
        );
    });
});
