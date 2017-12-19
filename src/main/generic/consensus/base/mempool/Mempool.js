class Mempool extends Observable {
    /**
     * @param {IBlockchain} blockchain
     * @param {Accounts} accounts
     */
    constructor(blockchain, accounts) {
        super();
        /** @type {IBlockchain} */
        this._blockchain = blockchain;
        /** @type {Accounts} */
        this._accounts = accounts;

        // Our pool of transactions.
        /** @type {HashMap.<Hash, Transaction>} */
        this._transactionsByHash = new HashMap();
        /** @type {HashMap.<Address, MempoolTransactionSet>} */
        this._transactionSetByAddress = new HashMap();
        /** @type {Synchronizer} */
        this._synchronizer = new Synchronizer();

        // Listen for changes in the blockchain head to evict transactions that
        // have become invalid.
        blockchain.on('head-changed', () => this._evictTransactions());
    }

    /**
     * @param {Transaction} transaction
     * @fires Mempool#transaction-added
     * @returns {Promise.<boolean>}
     */
    pushTransaction(transaction) {
        return this._synchronizer.push(() => this._pushTransaction(transaction));
    }

    /**
     * @param {Transaction} transaction
     * @returns {Promise.<boolean>}
     * @private
     */
    async _pushTransaction(transaction) {
        // Check if we already know this transaction.
        const hash = await transaction.hash();
        if (this._transactionsByHash.contains(hash)) {
            Log.v(Mempool, () => `Ignoring known transaction ${hash.toBase64()}`);
            return false;
        }

        // Intrinsic transaction verification
        if (!(await transaction.verify())) {
            return false;
        }

        // Retrieve sender account.
        /** @type {Account} */
        let senderAccount;
        try {
            senderAccount = await this._accounts.get(transaction.sender, transaction.senderType);
        } catch (e) {
            Log.w(Mempool, `Rejected transaction - ${e.message}`, transaction);
            return false;
        }

        // Fully verify the transaction against the current accounts state + Mempool.
        const set = this._transactionSetByAddress.get(transaction.sender) || new MempoolTransactionSet();
        if (!(await senderAccount.verifyOutgoingTransactionSet([...set.transactions, transaction], this._blockchain.height + 1, this._blockchain.transactionsCache))) {
            return false;
        }

        // Transaction is valid, add it to the mempool.
        set.add(transaction);
        this._transactionsByHash.put(hash, transaction);
        this._transactionSetByAddress.put(transaction.sender, set);

        // Tell listeners about the new valid transaction we received.
        this.fire('transaction-added', transaction);

        return true;
    }

    /**
     * @param {Hash} hash
     * @returns {Transaction}
     */
    getTransaction(hash) {
        return this._transactionsByHash.get(hash);
    }

    /**
     * @param {number} [maxSize]
     * @returns {Array.<Transaction>}
     */
    getTransactions(maxSize=Infinity) {
        const transactions = [];
        let size = 0;
        for (const tx of this._transactionsByHash.values().sort((a, b) => a.compare(b))) {
            const txSize = tx.serializedSize;
            if (size + txSize >= maxSize) continue;

            transactions.push(tx);
            size += txSize;
        }

        return transactions;
    }

    /**
     * @param {number} maxSize
     */
    getTransactionsForBlock(maxSize) {
        return this.getTransactions(maxSize);
    }

    /**
     * @param {Address} address
     * @return {Array.<Transaction>}
     */
    getWaitingTransactions(address) {
        if (this._transactionSetByAddress.contains(address)) {
            return this._transactionSetByAddress.get(address).transactions;
        } else {
            return [];
        }
    }

    /**
     * @fires Mempool#transactions-ready
     * @returns {Promise}
     * @private
     */
    _evictTransactions() {
        return this._synchronizer.push(() => this.__evictTransactions());
    }

    /**
     * @fires Mempool#transactions-ready
     * @returns {Promise}
     * @private
     */
    async __evictTransactions() {
        // Evict all transactions from the pool that have become invalid due
        // to changes in the account state (i.e. typically because the were included
        // in a newly mined block). No need to re-check signatures.
        for (const sender of this._transactionSetByAddress.keys()) {
            /** @type {MempoolTransactionSet} */ const set = this._transactionSetByAddress.get(sender);

            try {
                const senderAccount = await this._accounts.get(set.sender, set.senderType);
                while (!(await senderAccount.verifyOutgoingTransactionSet(set.transactions, this._blockchain.height + 1, this._blockchain.transactionsCache, true))) {
                    const transaction = set.pop();
                    if (transaction) {
                        this._transactionsByHash.remove(await transaction.hash());
                    }
                    if (set.length === 0) {
                        this._transactionSetByAddress.remove(sender);
                        break;
                    }
                }
            } catch (e) {
                let transaction;
                while ((transaction = set.pop())) {
                    this._transactionsByHash.remove(await transaction.hash());
                }
                this._transactionSetByAddress.remove(sender);
            }
        }

        // Tell listeners that the pool has updated after a blockchain head change.
        /**
         * @event Mempool#transactions-ready
         */
        this.fire('transactions-ready');
    }
}

Class.register(Mempool);
