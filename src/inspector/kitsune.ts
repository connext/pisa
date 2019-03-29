import { IKitsuneAppointmentRequest, ChannelType } from "../dataEntities";
import { IInspector } from "./inspector";
import { PublicInspectionError } from "../dataEntities/errors";
import KitsuneTools from "../integrations/kitsune/tools";
import { ethers } from "ethers";
import { verifyMessage } from "ethers/utils";
import logger from "../logger";

/**
 * Responsible for deciding whether to accept Kitsune appointments
 */
export class KitsuneInspector implements IInspector {
    constructor(public readonly minimumDisputePeriod: number, public readonly provider: ethers.providers.Provider) {}
    public readonly channelType = ChannelType.Kitsune;

    /**
     * Inspects an appointment to decide whether to accept it. Throws on reject.
     * @param appointmentRequest
     */
    public async inspect(appointmentRequest: IKitsuneAppointmentRequest) {
        const contractAddress: string = appointmentRequest.stateUpdate.contractAddress;

        // log the appointment we're inspecting
        logger.info(
            `Inspecting appointment ${JSON.stringify(
                appointmentRequest.stateUpdate.hashState
            )} for contract ${contractAddress}.`
        );
        logger.debug("Appointment request: " + JSON.stringify(appointmentRequest));
        const code: string = await this.provider.getCode(contractAddress);
        // check that the channel is a contract
        if (code === "0x" || code === "0x00") {
            throw new PublicInspectionError(`No code found at address ${contractAddress}`);
        }
        if (code != KitsuneTools.ContractDeployedBytecode) {
            throw new PublicInspectionError(`Contract at: ${contractAddress} does not have correct bytecode.`);
        }

        // create a contract reference
        const contract: ethers.Contract = new ethers.Contract(contractAddress, KitsuneTools.ContractAbi, this.provider);

        // verify the appointment
        await this.verifyAppointment(
            appointmentRequest.stateUpdate.signatures,
            contract,
            appointmentRequest.stateUpdate.round,
            appointmentRequest.stateUpdate.hashState,
            this.minimumDisputePeriod
        );

        // an additional check to help the client, and the perception of PISA -
        // this isn't strictly necessary but it might catch some mistakes
        // if a client submits a request for an appointment that will always expire before a dispute can complete then
        // there is never any recourse against PISA.
        const channelDisputePeriod: number = await contract.disputePeriod();
        logger.info(`Dispute period at ${contract.address}: ${channelDisputePeriod.toString(10)}`);
        if (appointmentRequest.expiryPeriod <= channelDisputePeriod) {
            throw new PublicInspectionError(
                `Supplied appointment expiryPeriod ${
                    appointmentRequest.expiryPeriod
                } is not greater than the channel dispute period ${channelDisputePeriod}`
            );
        }
    }

    /**
     * ******** SPEC **********
     * VerifyAppointment implements the spec described in the paper
     * http://www0.cs.ucl.ac.uk/staff/P.McCorry/pisa.pdf
     * @param signatures
     * @param contract
     * @param appointmentRound
     * @param hState
     * @param minimumDisputePeriod
     */
    public async verifyAppointment(
        signatures: string[],
        contract: ethers.Contract,
        appointmentRound: number,
        hState: string,
        minimumDisputePeriod: number
    ) {
        // check that the channel round is greater than the current round
        const currentChannelRound: number =  await contract.bestRound();
        logger.info(`Round at ${contract.address}: ${currentChannelRound.toString(10)}`);
        if (appointmentRound <= currentChannelRound) {
            throw new PublicInspectionError(
                `Supplied appointment round ${appointmentRound} is not greater than channel round ${currentChannelRound}`
            );
        }

        // check that the channel has a reasonable dispute period
        const channelDisputePeriod: number = await contract.disputePeriod();
        logger.info(`Dispute period at ${contract.address}: ${channelDisputePeriod.toString(10)}`);
        if (channelDisputePeriod <= minimumDisputePeriod) {
            throw new PublicInspectionError(
                `Channel dispute period ${channelDisputePeriod} is less than or equal the minimum acceptable dispute period ${minimumDisputePeriod}`
            );
        }

        // check that the channel is currently in the ON state
        const channelStatus: number = await contract.status();
        logger.info(`Channel status at ${contract.address}: ${JSON.stringify(channelStatus)}`);
        // ON = 0, DISPUTE = 1, OFF = 2
        if (channelStatus != 0) {
            throw new PublicInspectionError(`Channel status is ${channelStatus} not 0.`);
        }

        //verify all the signatures
        // get the participants
        let participants: string[] = await [await contract.plist(0), await contract.plist(1)] as string[];
        logger.info(`Participants at ${contract.address}: ${JSON.stringify(participants)}`);

        // form the hash
        const setStateHash = KitsuneTools.hashForSetState(hState, appointmentRound, contract.address);

        // check the sigs
        this.verifySignatures(participants, setStateHash, signatures);
        logger.info("All participants have signed.");
    }

    /**
     * Check that every participant that every participant has signed the message.
     * @param message
     * @param participants
     * @param sigs
     */
    private verifySignatures(participants: string[], message: string, sigs: string[]) {
        if (participants.length !== sigs.length) {
            throw new PublicInspectionError(
                `Incorrect number of signatures supplied. Participants: ${participants.length}, signers: ${
                    sigs.length
                }.`
            );
        }

        const signers = sigs.map(sig => verifyMessage(ethers.utils.arrayify(message), sig));
        participants.forEach(party => {
            const signerIndex = signers.map(m => m.toLowerCase()).indexOf(party.toLowerCase());
            if (signerIndex === -1) {
                throw new PublicInspectionError(`Party ${party} not present in signatures.`);
            }

            // remove the signer, so that we never look for it again
            signers.splice(signerIndex, 1);
        });
    }
}