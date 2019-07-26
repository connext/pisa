import { ethers } from "ethers";
import appointmentRequestSchemaJson from "./appointmentRequestSchema.json";
import Ajv from "ajv";
import { PublicDataValidationError } from "./errors";
import logger from "../logger";
import { BigNumber } from "ethers/utils";
import { groupTuples } from "../utils/ethers";
const ajv = new Ajv();
const appointmentRequestValidation = ajv.compile(appointmentRequestSchemaJson);

export interface IAppointmentBase {
    /**
     * The address of the external contract to which the data will be submitted
     */
    readonly contractAddress: string;

    /**
     * The address of the customer hiring PISA
     */
    readonly customerAddress: string;

    /**
     * The block at which the appointment starts
     */
    readonly startBlock: number;

    /**
     * The block at which the appointment ends
     */
    readonly endBlock: number;

    /**
     * if the trigger event is noticed, then this is the number of blocks which
     * PISA has to respond
     */
    readonly challengePeriod: number;

    /**
     * A counter that allows users to replace existing jobs
     */
    readonly jobId: number;

    /**
     * The data to supply when calling the external address from inside the contract
     */
    readonly data: string;

    /**
     * How much to refund the customer by, in wei
     */
    readonly refund: number;

    /**
     * The amount of gas to use when calling the external contract with the provided data
     */
    readonly gas: number;

    /**
     * An identifier for the dispute handler to be used in checking state during recourse
     */
    readonly mode: number;

    /**
     * A human readable (https://blog.ricmoo.com/human-readable-contract-abis-in-ethers-js-141902f4d917) event abi
     */
    readonly eventABI: string;

    /**
     * ABI encoded event arguments for the event
     */
    readonly eventArgs: string;

    /**
     * The post-condition data to be passed to the dispute handler to verify whether
     * recouse is required
     */
    readonly postCondition: string;

    /**
     * the hash used for fair exchange of the appointment. The customer will be required to
     * reveal the pre-image of this to seek recourse, which will only be given to them upon payment
     */
    readonly paymentHash: string;
}

export interface IAppointmentRequest extends IAppointmentBase {
    /**
     * an appointment id, supplied by the customer
     */
    readonly id: number;
}

export interface IAppointment extends IAppointmentBase {
    /**
     * an appointment id, supplied by the customer
     */
    readonly customerChosenId: number;
}

/**
 * A customer appointment, detailing what event to be watched for and data to submit.
 */
export class Appointment implements IAppointment {
    constructor(
        public readonly contractAddress: string,
        public readonly customerAddress: string,
        public readonly startBlock: number,
        public readonly endBlock: number,
        public readonly challengePeriod: number,
        public readonly customerChosenId: number,
        public readonly jobId: number,
        public readonly data: string,
        public readonly refund: number,
        public readonly gas: number,
        public readonly mode: number,
        public readonly eventABI: string,
        public readonly eventArgs: string,
        public readonly postCondition: string,
        public readonly paymentHash: string
    ) {}

    public static fromIAppointment(appointment: IAppointment): Appointment {
        return new Appointment(
            appointment.contractAddress,
            appointment.customerAddress,
            appointment.startBlock,
            appointment.endBlock,
            appointment.challengePeriod,
            appointment.customerChosenId,
            appointment.jobId,
            appointment.data,
            appointment.refund,
            appointment.gas,
            appointment.mode,
            appointment.eventABI,
            appointment.eventArgs,
            appointment.postCondition,
            appointment.paymentHash
        );
    }

    public static toIAppointment(appointment: Appointment): IAppointment {
        return {
            contractAddress: appointment.contractAddress,
            customerAddress: appointment.customerAddress,
            startBlock: appointment.startBlock,
            endBlock: appointment.endBlock,
            challengePeriod: appointment.challengePeriod,
            customerChosenId: appointment.customerChosenId,
            jobId: appointment.jobId,
            data: appointment.data,
            refund: appointment.refund,
            gas: appointment.gas,
            mode: appointment.mode,
            eventABI: appointment.eventABI,
            eventArgs: appointment.eventArgs,
            postCondition: appointment.postCondition,
            paymentHash: appointment.paymentHash
        };
    }

    /**
     * Currently we dont charge access to the API. But when we payment will be proved
     * by being able to reveal the pre-image of the payment hash. Even though the API is
     * free we'll use payment hash now to keep the same structure of appointment as we'll
     * use when we add payment. For now clients can gain access to the API by putting the 
     * hash of 'on-the-house' as the payment hash.
     */
    public static FreeHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("on-the-house"));

    /**
     * Parse the appointment and check that it's valid
     * @param obj
     */
    public static validate(obj: any) {
        const valid = appointmentRequestValidation(obj);
        if (!valid) throw new PublicDataValidationError(appointmentRequestValidation.errors!.map(e => `${e.propertyName}:${e.message}`).join("\n")); // prettier-ignore
        const request = obj as IAppointmentRequest;

        const appointmentData: IAppointment = {
            ...request,
            customerChosenId: request.id
        };

        const appointment = Appointment.fromIAppointment(appointmentData);
        if (appointment.paymentHash !== Appointment.FreeHash) throw new PublicDataValidationError("Invalid payment hash."); // prettier-ignore

        try {
            appointment.getEventFilter();
        } catch (doh) {
            const dohError = doh as Error;
            logger.error(doh);
            if (dohError.stack) logger.error(dohError.stack);
            throw new PublicDataValidationError("Invalid event arguments for ABI.");
        }

        return appointment;
    }

    /**
     * A non-unique identifier for an appointment. Many appointments from the same customer
     * can have the same locator, but appointments with the same locator must have different job
     * ids.
     */
    public get locator() {
        return `${this.customerChosenId}|${this.customerAddress}`;
    }
    /**
     * A unique id for this appointment. Many appointments can have the same locator
     * but they must all have unique ids. Generated from concatenating the locator with
     * the job id. Appointments with the same locator can be replaced by incrementing the
     * job id.
     */
    public get id() {
        return `${this.locator}|${this.jobId}`;
    }

    public formatLog(message: string): string {
        return `|${this.id}| ${message}`;
    }

    /**
     * An event filter for this appointment. Created by combining the provided
     * eventABI and the eventArgs
     */
    public get eventFilter() {
        if (!this.mEventFilter) {
            this.mEventFilter = this.getEventFilter();
        }
        return this.mEventFilter;
    }
    private mEventFilter: ethers.EventFilter;
    private getEventFilter(): ethers.EventFilter {
        // the abi is in human readable format, we can parse it with ethersjs
        // then check that it's of the right form before separating the name and inputs
        // to form topics

        const eventInterface = new ethers.utils.Interface([this.eventABI]);
        if (eventInterface.abi.length !== 1) throw new PublicDataValidationError("Invalid ABI. ABI must specify a single event."); // prettier-ignore
        const event = eventInterface.abi[0];

        if (event.type !== "event") throw new PublicDataValidationError("Invalid ABI. ABI must specify an event.");

        const name = eventInterface.abi[0].name;
        const inputs = eventInterface.abi[0].inputs;

        // we encode within the data which inputs we'll be filtering on
        // so the first thing encoded is an array of integers representing the
        // indexes of the arguments that will be used in the filter.
        // non specified indexes will be null
        const indexes: BigNumber[] = ethers.utils.defaultAbiCoder.decode(["uint256[]"], this.eventArgs)[0];
        const namedInputs = indexes.map(i => i.toNumber()).map(i => inputs[i]);
        const decodedInputs = ethers.utils.defaultAbiCoder
            .decode(["uint256[]"].concat(namedInputs.map(i => i.type)), this.eventArgs)
            .slice(1);

        const topics = eventInterface.events[name].encodeTopics(decodedInputs);
        return {
            address: this.contractAddress,
            topics
        };
    }

    /**
     * The ABI encoded tightly packed representation for this appointment
     */
    public solidityPacked() {
        return ethers.utils.solidityPack(
            ...groupTuples([
                ["address", this.contractAddress],
                ["address", this.customerAddress],
                ["uint", this.startBlock],
                ["uint", this.endBlock],
                ["uint", this.challengePeriod],
                ["uint", this.customerChosenId],
                ["uint", this.jobId],
                ["bytes", this.data],
                ["uint", this.refund],
                ["uint", this.gas],
                ["uint", this.mode],
                ["bytes", ethers.utils.toUtf8Bytes(this.eventABI)],
                ["bytes", this.eventArgs],
                ["bytes", this.postCondition],
                ["bytes32", this.paymentHash]
            ])
        );
    }
}

/**
 * An appointment signed by PISA
 */
export class SignedAppointment {
    constructor(public readonly appointment: IAppointment, public readonly signature: string) {}
    public serialise() {
        const signedAppointment: IAppointmentRequest & { signature: string } = {
            challengePeriod: this.appointment.challengePeriod,
            contractAddress: this.appointment.contractAddress,
            customerAddress: this.appointment.customerAddress,
            data: this.appointment.data,
            endBlock: this.appointment.endBlock,
            eventABI: this.appointment.eventABI,
            eventArgs: this.appointment.eventArgs,
            gas: this.appointment.gas,
            id: this.appointment.customerChosenId,
            jobId: this.appointment.jobId,
            mode: this.appointment.mode,
            paymentHash: this.appointment.paymentHash,
            postCondition: this.appointment.postCondition,
            refund: this.appointment.refund,
            startBlock: this.appointment.startBlock,
            signature: this.signature
        };

        return JSON.stringify(signedAppointment);
    }
}
