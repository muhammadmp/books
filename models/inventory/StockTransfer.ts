import { Fyo, t } from 'fyo';
import { Attachment } from 'fyo/core/types';
import { Doc } from 'fyo/model/doc';
import { Action, DefaultMap, FiltersMap, FormulaMap } from 'fyo/model/types';
import { ValidationError } from 'fyo/utils/errors';
import { Defaults } from 'models/baseModels/Defaults/Defaults';
import { Invoice } from 'models/baseModels/Invoice/Invoice';
import { getLedgerLinkAction, getNumberSeries } from 'models/helpers';
import { LedgerPosting } from 'models/Transactional/LedgerPosting';
import { ModelNameEnum } from 'models/types';
import { Money } from 'pesa';
import { StockTransferItem } from './StockTransferItem';
import { Transfer } from './Transfer';

export abstract class StockTransfer extends Transfer {
  name?: string;
  date?: Date;
  party?: string;
  terms?: string;
  attachment?: Attachment;
  grandTotal?: Money;
  backReference?: string;
  items?: StockTransferItem[];

  get isSales() {
    return this.schemaName === ModelNameEnum.Shipment;
  }

  formulas: FormulaMap = {
    grandTotal: {
      formula: () => this.getSum('items', 'amount', false),
      dependsOn: ['items'],
    },
  };

  static defaults: DefaultMap = {
    numberSeries: (doc) => getNumberSeries(doc.schemaName, doc.fyo),
    terms: (doc) => {
      const defaults = doc.fyo.singles.Defaults as Defaults | undefined;
      if (doc.schemaName === ModelNameEnum.Shipment) {
        return defaults?.shipmentTerms ?? '';
      }

      return defaults?.purchaseReceiptTerms ?? '';
    },
    date: () => new Date().toISOString().slice(0, 10),
  };

  static filters: FiltersMap = {
    party: (doc: Doc) => ({
      role: ['in', [doc.isSales ? 'Customer' : 'Supplier', 'Both']],
    }),
    numberSeries: (doc: Doc) => ({ referenceType: doc.schemaName }),
  };

  override _getTransferDetails() {
    return (this.items ?? []).map((row) => {
      let fromLocation = undefined;
      let toLocation = undefined;

      if (this.isSales) {
        fromLocation = row.location;
      } else {
        toLocation = row.location;
      }

      return {
        item: row.item!,
        rate: row.rate!,
        quantity: row.quantity!,
        fromLocation,
        toLocation,
      };
    });
  }

  override async getPosting(): Promise<LedgerPosting | null> {
    await this.validateAccounts();
    const stockInHand = (await this.fyo.getValue(
      ModelNameEnum.InventorySettings,
      'stockInHand'
    )) as string;

    const amount = this.grandTotal ?? this.fyo.pesa(0);
    const posting = new LedgerPosting(this, this.fyo);

    if (this.isSales) {
      const costOfGoodsSold = (await this.fyo.getValue(
        ModelNameEnum.InventorySettings,
        'costOfGoodsSold'
      )) as string;

      await posting.debit(costOfGoodsSold, amount);
      await posting.credit(stockInHand, amount);
    } else {
      const stockReceivedButNotBilled = (await this.fyo.getValue(
        ModelNameEnum.InventorySettings,
        'stockReceivedButNotBilled'
      )) as string;

      await posting.debit(stockInHand, amount);
      await posting.credit(stockReceivedButNotBilled, amount);
    }

    await posting.makeRoundOffEntry();
    return posting;
  }

  async validateAccounts() {
    const settings: string[] = ['stockInHand'];
    if (this.isSales) {
      settings.push('costOfGoodsSold');
    } else {
      settings.push('stockReceivedButNotBilled');
    }

    const messages: string[] = [];
    for (const setting of settings) {
      const value = this.fyo.singles.InventorySettings?.[setting] as
        | string
        | undefined;
      const field = this.fyo.getField(ModelNameEnum.InventorySettings, setting);
      if (!value) {
        messages.push(t`${field.label} account not set in Inventory Settings.`);
        continue;
      }

      const exists = await this.fyo.db.exists(ModelNameEnum.Account, value);
      if (!exists) {
        messages.push(t`Account ${value} does not exist.`);
      }
    }

    if (messages.length) {
      throw new ValidationError(messages.join(' '));
    }
  }

  static getActions(fyo: Fyo): Action[] {
    return [getLedgerLinkAction(fyo, false), getLedgerLinkAction(fyo, true)];
  }

  async afterSubmit() {
    await super.afterSubmit();
    await this._updateBackReference();
  }

  async afterCancel(): Promise<void> {
    await super.afterCancel();
    await this._updateBackReference();
  }

  async _updateBackReference() {
    if (!this.isCancelled && !this.isSubmitted) {
      return;
    }

    if (!this.backReference) {
      return;
    }

    const schemaName = this.isSales
      ? ModelNameEnum.SalesInvoice
      : ModelNameEnum.PurchaseInvoice;

    const invoice = (await this.fyo.doc.getDoc(
      schemaName,
      this.backReference
    )) as Invoice;
    const transferMap = this._getTransferMap();

    for (const row of invoice.items ?? []) {
      const item = row.item!;
      const quantity = row.quantity!;
      const notTransferred = (row.stockNotTransferred as number) ?? 0;

      const transferred = transferMap[item];
      if (
        typeof transferred !== 'number' ||
        typeof notTransferred !== 'number'
      ) {
        continue;
      }

      if (this.isCancelled) {
        await row.set(
          'stockNotTransferred',
          Math.min(notTransferred + transferred, quantity)
        );
        transferMap[item] = Math.max(
          transferred + notTransferred - quantity,
          0
        );
      } else {
        await row.set(
          'stockNotTransferred',
          Math.max(notTransferred - transferred, 0)
        );
        transferMap[item] = Math.max(transferred - notTransferred, 0);
      }
    }

    const notTransferred = invoice.getStockNotTransferred();
    await invoice.setAndSync('stockNotTransferred', notTransferred);
  }

  _getTransferMap() {
    return (this.items ?? []).reduce((acc, item) => {
      if (!item.item) {
        return acc;
      }

      if (!item.quantity) {
        return acc;
      }

      acc[item.item] ??= 0;
      acc[item.item] += item.quantity;

      return acc;
    }, {} as Record<string, number>);
  }

  override duplicate(): Doc {
    const doc = super.duplicate() as StockTransfer;
    doc.backReference = undefined;
    return doc;
  }

  static createFilters: FiltersMap = {
    party: (doc: Doc) => ({
      role: doc.isSales ? 'Customer' : 'Supplier',
    }),
  };
}
