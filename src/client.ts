import assert from 'assert';
import path from 'path';

import { DEFULT_GAS_PRICE } from './constants';
import { DummyKey } from './dummyKey';

import {
  Account,
  CreateTxOptions,
  MnemonicKey,
  LCDClient,
  Wallet,
  MsgSend,
  MsgSwap,
  StdSignature,
  StdTx,
  StdSignMsg,
  StdFee,
  Coin,
  Coins,
  Denom,
} from '@terra-money/terra.js';

import {
  EcdsaParty2 as Party2,
  EcdsaParty2Share as Party2Share,
  EcdsaSignature as MPCSignature,
} from '@kzen-networks/thresh-sig';

import SHA256 from 'crypto-js/sha256';

const P1_ENDPOINT = 'http://localhost:8000';
const HD_COIN_INDEX = 0;
const CLIENT_DB_PATH = path.join(__dirname, '../../client_db');

import fs from 'fs';
import low from 'lowdb';
import FileSync from 'lowdb/adapters/FileSync';

type SendOptions = {
  memo?: string;
  feeDenom?: Denom;
};

interface LocalCreateTxOptions extends CreateTxOptions {
  fromAddress: string;
}

export class TerraThreshSigClient {
  private mainnet: boolean;
  private db: any;
  private p2: Party2;
  private p2MasterKeyShare: Party2Share;
  private terraWallet: Wallet;

  constructor(mainnet: boolean = false) {
    this.p2 = new Party2(P1_ENDPOINT);
  }

  public async getBalance(address: string): Promise<Coins> {
    return this.terraWallet.lcd.bank.balance(address);
  }

  /**
   * Transfer tokens to address
   * @param amount Amount of tokens to swa in u<Token>  == <Token> * 1e6
   * @param denom Denomination of tokens to use. One of uluna, uusd, ukrw etc.
   * @param ask Denom of tokens to received. One of uluna, uusd, ukrw
   * @param dryRun Create trasnsaction but do not broadcast
   */
  public async swap(
    from: string,
    amount: string,
    denom: Denom,
    ask: Denom,
    options?: SendOptions,
    dryRun?: boolean,
  ) {
    let offer = new Coin(denom, amount);

    // This is an example of creating a transaction without breaking down to stesp
    const msg = new MsgSwap(this.terraWallet.key.accAddress, offer, ask);

    // This is
    const tx = await this.terraWallet.createAndSignTx({
      msgs: [msg],
    });

    if (dryRun) {
      console.log('------ Dry Run ----- ');
      console.log(tx.toJSON());
    } else {
      console.log(' ===== Executing ===== ');
      console.log(tx.toJSON());
      let resp = await this.terraWallet.lcd.tx.broadcast(tx);
      return resp;
    }
  }

  /**
   * Checks that the account has at least as much balance as requested by transaction
   * Returns balance in Coins for future use
   */
  private async checkEnoughBalance(
    address: string,
    amount: string,
    denom: Denom,
  ): Promise<Coins> {
    const balance = await this.getBalance(address);
    const balanceCoins = balance.filter((res) => res.denom === denom);
    assert(
      Number(amount) < Number(balanceCoins.get(denom)?.toData().amount),
      'Not enough balance',
    );
    return balance;
  }

  private async createTransferTx(
    from: string,
    to: string,
    amount: string,
    denom: Denom,
    options?: SendOptions,
    sendAll?: boolean,
  ): Promise<StdSignMsg> {
    // For sending all, set the amount to the minimum, so that gas estimation works properly
    if (sendAll) {
      // Place holder so that gas estimation will not fail
      amount = '1';
    }
    // Optionally add a memo the transaction
    const memo: string = (options && options.memo) || '';
    const balance = await this.checkEnoughBalance(from, amount, denom);

    // Set default denom to uluna
    if (denom == null) {
      denom = 'uluna';
    }

    // Coins for amount
    let coin = new Coin(denom, amount);
    let coins = new Coins([coin]);

    // Coins for gas fees
    const gasPriceCoin = new Coin(denom, DEFULT_GAS_PRICE);
    const gasPriceCoins = new Coins([gasPriceCoin]);

    let send = new MsgSend(from, to, coins);

    // Create tx
    // This also estimates the initial fees
    let tx = await this.createTx({
      msgs: [send],
      gasPrices: gasPriceCoins,
      fromAddress: from,
    });

    // Extract estimated fee
    let fee = tx.fee;

    // Covernt balance to Coins in relevant denom
    const balanceCoins = balance.filter((res) => res.denom === denom);

    // console.log('Amount', amount);
    // console.log('Fees', fee.amount.get(denom)?.toData().amount);
    // console.log('Balance', Number(balanceCoins.get(denom)?.toData().amount));

    // Make sure the fees + amount are sufficient
    assert(
      Number(fee.amount.get(denom)?.toData().amount) + Number(amount) <=
        Number(balanceCoins.get(denom)?.toData().amount),
      'Not enough balance to cover the fees',
    );

    // Special care for sending all
    if (sendAll) {
      // Deduct fees from the balance of tokens
      let amountSubFee = balanceCoins.sub(fee.amount);

      // For tokens other than LUNA, an additional stablity tax is payed
      if (denom != 'uluna') {
        // Tax rate per token sent
        const taxRate = await this.terraWallet.lcd.treasury.taxRate();
        // Cap on max tax per transactions
        const taxCap = await this.terraWallet.lcd.treasury.taxCap(denom);
        const taxCapAmount = Number(taxCap.toData().amount);
        // Subtract known fees from amount to be sent
        let taxedAmount = amountSubFee.get(denom)?.toData().amount;
        // Take the min between the max tax and the tax for tx
        let taxToPay = Math.floor(
          Math.min(taxCapAmount, Number(taxRate) * Number(taxedAmount)),
        );

        let taxCoin = new Coin(denom, taxToPay);
        // Subtract tax from the payed amount
        amountSubFee = amountSubFee.sub(taxCoin);
        // Add tax to the fee to be payed
        fee = new StdFee(fee.gas, fee.amount.add(taxCoin));
      }
      // Create a new message with adjusted amount
      send = new MsgSend(from, to, amountSubFee);

      // Create a new Tx with the updates fees
      tx = await this.createTx({
        msgs: [send],
        fee: fee,
        fromAddress: from,
      });
    }
    return tx;
  }

  /**
   * Transfer tokens to address
   * @param to  address to send tokens to
   * @param amount Amount of tokens to send in u<Token>  == <Token> * 1e6
   * @param denom Denomination of tokens to use. One of uluna, uusd, ukrw etc.
   * @param options Optional memo and different gas fees
   * @param sendAll Use special logic to send all tokens of specified denom
   * @param dryRun Create trasnsaction but do not broadcast
   */
  public async transfer(
    from: string,
    to: string,
    amount: string,
    denom: Denom,
    options?: SendOptions,
    sendAll?: boolean,
    syncSend?: boolean,
    dryRun?: boolean,
  ) {
    ////////////////////// Siging and broadcasting is split into steps ////////////////
    // Step 1: creating the trasnsaction (done)
    const tx = await this.createTransferTx(
      from,
      to,
      amount,
      denom,
      options,
      sendAll,
    );

    // Get relevant from address index (for sign and public key)
    const addressObj: any = this.db
      .get('addresses')
      .find({ accAddress: from })
      .value();

    const addressIndex: number = addressObj.index;

    // Step 2: Signing the message
    // Sign the raw tx data
    let sigData = await this.sign(addressIndex, Buffer.from(tx.toJSON()));

    let pubKey = this.getPublicKeyBuffer(addressIndex).toString('base64');

    // Step 3: Inject signature to messate
    // Createa a sig+public key object
    let stdSig = StdSignature.fromData({
      signature: sigData.toString('base64'),
      pub_key: {
        type: 'tendermint/PubKeySecp256k1',
        value: pubKey,
      },
    });

    // Create message object
    const stdTx = new StdTx(tx.msgs, tx.fee, [stdSig], tx.memo);

    // Step 3: Broadcasting the message
    if (dryRun) {
      console.log('------ Dry Run ----- ');
      console.log(tx.toJSON());
    } else {
      console.log(' ===== Executing ===== ');
      console.log(stdTx.toJSON());
      let resp;
      if (syncSend) {
        resp = await this.terraWallet.lcd.tx.broadcast(stdTx);
      } else {
        resp = await this.terraWallet.lcd.tx.broadcastSync(stdTx);
      }
      return resp;
    }
  }

  /**
   * Initiate the client
   * @param accAddress Address to use for wallet generation. Optional. Otherwise uses index 0
   */
  public async init() {
    this.initDb();
    this.initMasterKey();

    // The LCD clients must be initiated with a node and chain_id
    const terraClient = new LCDClient({
      URL: 'https://soju-lcd.terra.dev', // public node soju
      chainID: 'soju-0014',
    });
    // Place holder for the key, this will not work for signing
    let dummyKey = new DummyKey(Buffer.alloc(0));
    this.terraWallet = terraClient.wallet(dummyKey);
  }

  private initDb() {
    ensureDirSync(CLIENT_DB_PATH);
    const adapter = new FileSync(`${CLIENT_DB_PATH}/db.json`);
    this.db = low(adapter);
    this.db.defaults({ mkShare: null, addresses: [] }).write();
  }

  /**
   * Initialize the client's master key.
   * Will either generate a new one by the 2 party protocol, or restore one from previous session.
   * @return {Promise}
   */
  private async initMasterKey() {
    this.p2MasterKeyShare = await this.restoreOrGenerateMasterKey();
  }

  /**
   * Fetch the share from the database or create a new share with the server
   */
  private async restoreOrGenerateMasterKey(): Promise<Party2Share> {
    const p2MasterKeyShare = this.db.get('mkShare').value();
    if (p2MasterKeyShare) {
      return p2MasterKeyShare;
    }
    return this.generateMasterKeyShare();
  }

  private async generateMasterKeyShare(): Promise<Party2Share> {
    const p2MasterKeyShare: Party2Share = await this.p2.generateMasterKey();
    this.db.set('mkShare', p2MasterKeyShare).write();

    return p2MasterKeyShare;
  }

  /**
   * get the address of the specified index. If the index is omitted, will return the default address (of index 0).
   * @param addressIndex HD index of the address to get
   */
  public getAddress(addressIndex = 0): string {
    const publicKeyBuffer = this.getPublicKeyBuffer(addressIndex);
    // This is only to generate an address from public key
    const address = new DummyKey(publicKeyBuffer);

    const accAddress = address.accAddress;
    const dbAddress = this.db.get('addresses').find({ accAddress }).value();
    if (!dbAddress) {
      this.db
        .get('addresses')
        .push({ accAddress, index: addressIndex })
        .write();
    }
    return address.accAddress;
  }

  private getPublicKeyBuffer(addressIndex: number): Buffer {
    const publicKey = this.getPublicKey(addressIndex);
    const publicKeyHex = publicKey.encode('hex', true);
    return Buffer.from(publicKeyHex, 'hex');
  }

  private getPublicKey(addressIndex: number) {
    // assuming a single default address
    const p2ChildShare = this.p2.getChildShare(
      this.p2MasterKeyShare,
      HD_COIN_INDEX,
      addressIndex,
    );
    return p2ChildShare.getPublicKey();
  }

  // Two party signing function
  private async sign(addressIndex: number, payload: Buffer): Promise<Buffer> {
    const p2ChildShare: Party2Share = this.p2.getChildShare(
      this.p2MasterKeyShare,
      HD_COIN_INDEX,
      addressIndex,
    );

    const hash = Buffer.from(SHA256(payload.toString()).toString(), 'hex');

    const signatureMPC: MPCSignature = await this.p2.sign(
      hash,
      p2ChildShare,
      HD_COIN_INDEX,
      addressIndex,
    );
    const signature = signatureMPC.toBuffer();
    return signature;
  }
  ////////////////////////// Aux method to create tx without key //////////////
  public async accountNumber(fromAddress: string): Promise<number> {
    return this.terraWallet.lcd.auth.accountInfo(fromAddress).then((d) => {
      if (d instanceof Account) {
        return d.account_number;
      } else {
        return d.BaseAccount.account_number;
      }
    });
  }

  public async sequence(fromAddress: string): Promise<number> {
    return this.terraWallet.lcd.auth.accountInfo(fromAddress).then((d) => {
      if (d instanceof Account) {
        return d.sequence;
      } else {
        return d.BaseAccount.sequence;
      }
    });
  }

  public async createTx(options: LocalCreateTxOptions): Promise<StdSignMsg> {
    let { fee, memo } = options;
    const { msgs } = options;
    memo = memo || '';
    const estimateFeeOptions = {
      gasPrices: options.gasPrices || this.terraWallet.lcd.config.gasPrices,
      gasAdjustment:
        options.gasAdjustment || this.terraWallet.lcd.config.gasAdjustment,
    };

    const balance = await this.terraWallet.lcd.bank.balance(
      options.fromAddress,
    );
    const balanceOne = balance.map((c) => new Coin(c.denom, 1));
    // create the fake fee

    if (fee === undefined) {
      // estimate the fee
      const stdTx = new StdTx(msgs, new StdFee(0, balanceOne), [], memo);
      fee = await this.terraWallet.lcd.tx.estimateFee(
        stdTx,
        estimateFeeOptions,
      );
    }

    return new StdSignMsg(
      this.terraWallet.lcd.config.chainID,
      await this.accountNumber(options.fromAddress),
      await this.sequence(options.fromAddress),
      fee,
      msgs,
      memo,
    );
  }
}

function ensureDirSync(dirpath: string) {
  try {
    fs.mkdirSync(dirpath, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

// Create many terra addresses (for stress testing)
export function addressGenerator() {
  for (let i = 0; i < 70000; i++) {
    const mk = new MnemonicKey();
    console.log('"' + mk.accAddress + '",');
  }
}
