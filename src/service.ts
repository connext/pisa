import express, { Response } from "express";
import httpContext from "express-http-context";
import rateLimit from "express-rate-limit";
import { Server } from "http";
import { inspect } from "util";
import { ethers } from "ethers";
import logger from "./logger";
import {
    PublicInspectionError,
    PublicDataValidationError,
    ApplicationError,
    StartStopService,
    ChannelType,
    IEthereumAppointment
} from "./dataEntities";
import { Raiden, Kitsune } from "./integrations";
import { Watcher, AppointmentStore } from "./watcher";
import { PisaTower, HotEthereumAppointmentSigner } from "./tower";
import { setRequestId } from "./customExpressHttpContext";
import { EthereumResponderManager } from "./responder";
import { AppointmentStoreGarbageCollector } from "./watcher/garbageCollector";
import { AppointmentSubscriber } from "./watcher/appointmentSubscriber";
import { IArgConfig } from "./dataEntities/config";
import { ReorgDetector } from "./blockMonitor/reorg";
import { ReorgHeightListenerStore } from "./blockMonitor";
import { LevelUp } from "levelup";
import encodingDown from "encoding-down";

/**
 * Hosts a PISA service at the endpoint.
 */
export class PisaService extends StartStopService {
    private readonly server: Server;
    private readonly garbageCollector: AppointmentStoreGarbageCollector;
    private readonly reorgDetector: ReorgDetector;
    private readonly watcher: Watcher;
    private readonly appointmentStore: AppointmentStore;

    /**
     *
     * @param config PISA service configuration info
     * @param port The port on which to host the pisa service
     * @param provider A connection to ethereum
     * @param wallet A signing authority for submitting transactions
     * @param receiptSigner A signing authority for receipts returned from Pisa
     * @param delayedProvider A connection to ethereum that is delayed by a number of confirmations
     */
    constructor(
        config: IArgConfig,
        provider: ethers.providers.BaseProvider,
        wallet: ethers.Wallet,
        receiptSigner: ethers.Signer,
        delayedProvider: ethers.providers.BaseProvider,
        db: LevelUp<encodingDown<string, any>>
    ) {
        super("PISA");
        const app = express();

        this.applyMiddlewares(app, config);

        // choose configs
        const configs = [Raiden, Kitsune];

        // start reorg detector
        this.reorgDetector = new ReorgDetector(delayedProvider, 200, new ReorgHeightListenerStore());

        // dependencies
        this.appointmentStore = new AppointmentStore(
            db,
            new Map(configs.map<[ChannelType, (obj: any) => IEthereumAppointment]>(c => [c.channelType, c.appointment]))
        );
        const ethereumResponderManager = new EthereumResponderManager(wallet);
        const appointmentSubscriber = new AppointmentSubscriber(delayedProvider);
        this.watcher = new Watcher(
            delayedProvider,
            ethereumResponderManager,
            this.reorgDetector,
            appointmentSubscriber,
            this.appointmentStore
        );

        // gc
        this.garbageCollector = new AppointmentStoreGarbageCollector(
            provider,
            10,
            this.appointmentStore,
            appointmentSubscriber
        );

        // if a key to sign receipts was provided, create an EthereumAppointmentSigner
        const appointmentSigner = new HotEthereumAppointmentSigner(receiptSigner);

        // tower
        const tower = new PisaTower(provider, this.watcher, appointmentSigner, configs);

        app.post("/appointment", this.appointment(tower));

        const service = app.listen(config.hostPort, config.hostName);
        logger.info(`PISA listening on: ${config.hostName}:${config.hostPort}.`);
        this.server = service;
    }

    protected async startInternal() {
        await this.reorgDetector.start();
        await this.watcher.start();
        await this.garbageCollector.start();
        await this.appointmentStore.start();
    }

    protected async stopInternal() {
        await this.garbageCollector.stop();
        await this.reorgDetector.stop();
        await this.watcher.stop();
        await this.appointmentStore.stop();
        this.server.close(error => {
            if (error) logger.error(error.stack!);
            logger.info(`PISA shutdown.`);
        });
    }

    private applyMiddlewares(app: express.Express, config: IArgConfig) {
        // accept json request bodies
        app.use(express.json());
        // use http context middleware to create a request id available on all requests
        app.use(httpContext.middleware);
        app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
            setRequestId();
            next();
        });

        // rate limits
        if (config.rateLimitGlobalMax && config.rateLimitGlobalWindowMs) {
            app.use(
                new rateLimit({
                    keyGenerator: () => "global", // use the same key for all users
                    statusCode: 503, // = Too Many Requests (RFC 7231)
                    message: config.rateLimitGlobalMessage || "Server request limit reached. Please try again later.",
                    windowMs: config.rateLimitGlobalWindowMs,
                    max: config.rateLimitGlobalMax
                })
            );
            logger.info(
                `PISA api global rate limit: ${
                    config.rateLimitGlobalMax
                } requests every: ${config.rateLimitGlobalWindowMs / 1000} seconds.`
            );
        } else {
            logger.warn(`PISA api global rate limit: NOT SET.`);
        }

        if (config.rateLimitUserMax && config.rateLimitUserWindowMs) {
            app.use(
                new rateLimit({
                    keyGenerator: req => req.ip, // limit per IP
                    statusCode: 429, // = Too Many Requests (RFC 6585)
                    message: config.rateLimitUserMessage || "Too many requests. Please try again later.",
                    windowMs: config.rateLimitUserWindowMs,
                    max: config.rateLimitUserMax
                })
            );
            logger.info(
                `PISA api per-user rate limit: ${
                    config.rateLimitUserMax
                } requests every: ${config.rateLimitUserWindowMs / 1000} seconds.`
            );
        } else {
            logger.warn(`PISA api per-user rate limit: NOT SET.`);
        }
    }

    // PISA: it would be much nicer to log with appointment data in this handler
    // PISA: perhaps we can attach to the logger? should we be passing a logger to the tower itself?

    private appointment(tower: PisaTower) {
        return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
            try {
                const signedAppointment = await tower.addAppointment(req.body);

                // return the appointment
                res.status(200);

                // with signature
                res.send(signedAppointment.serialise());
            } catch (doh) {
                if (doh instanceof PublicInspectionError) this.logAndSend(400, doh.message, doh, res);
                else if (doh instanceof PublicDataValidationError) this.logAndSend(400, doh.message, doh, res);
                else if (doh instanceof ApplicationError) this.logAndSend(500, doh.message, doh, res);
                else if (doh instanceof Error) this.logAndSend(500, "Internal server error.", doh, res);
                else {
                    logger.error("Error: 500. \n" + inspect(doh));
                    res.status(500);
                    res.send("Internal server error.");
                }
            }
        };
    }

    private logAndSend(code: number, responseMessage: string, error: Error, res: Response) {
        logger.error(`HTTP Status: ${code}.`);
        logger.error(error.stack!);
        res.status(code);
        res.send(responseMessage);
    }
}
