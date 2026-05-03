/**
 * Domain errors raised by route handlers. The api-handler wrapper turns these
 * into stable JSON error responses with the right HTTP status. Adding a new
 * domain error means: subclass DomainError + throw from a handler.
 */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Authentication required.') {
    super('UNAUTHORIZED', message, 401);
  }
}

export class InvalidCredentialsError extends DomainError {
  constructor() {
    super('INVALID_CREDENTIALS', 'Invalid email or password.', 401);
  }
}

export class EmailTakenError extends DomainError {
  constructor() {
    super('EMAIL_TAKEN', 'That email is already registered.', 409);
  }
}

export class DisplayNameTakenError extends DomainError {
  constructor() {
    super('DISPLAY_NAME_TAKEN', 'That display name is already taken.', 409);
  }
}

// Foundations for later phases — defined here so the api-handler is consistent
// across the codebase. Phases 5/9/10 throw these.
export class SoldOutError extends DomainError {
  constructor() {
    super('SOLD_OUT', 'This pack drop is sold out.', 409);
  }
}
export class InsufficientFundsError extends DomainError {
  constructor() {
    super('INSUFFICIENT_FUNDS', 'Insufficient funds.', 402);
  }
}
export class DropNotOpenError extends DomainError {
  constructor() {
    super('DROP_NOT_OPEN', 'This drop is not open yet.', 409);
  }
}
export class ListingUnavailableError extends DomainError {
  constructor() {
    super('LISTING_UNAVAILABLE', 'This listing is no longer available.', 409);
  }
}
export class CardNotAvailableError extends DomainError {
  constructor() {
    super('CARD_NOT_AVAILABLE', 'This card is not available for that action.', 409);
  }
}
export class AuctionClosedError extends DomainError {
  constructor() {
    super('AUCTION_CLOSED', 'This auction is closed.', 409);
  }
}
export class BidTooLowError extends DomainError {
  constructor() {
    super('BID_TOO_LOW', 'Bid is below the minimum increment.', 409);
  }
}
export class SellerCannotBidError extends DomainError {
  constructor() {
    super('SELLER_CANNOT_BID', 'Sellers cannot bid on their own auctions.', 403);
  }
}
export class ListingNotFoundError extends DomainError {
  constructor() {
    super('LISTING_NOT_FOUND', 'Listing not found.', 404);
  }
}
export class NotListingOwnerError extends DomainError {
  constructor() {
    super('NOT_LISTING_OWNER', 'Only the seller can perform that action.', 403);
  }
}
export class SellerCannotBuyOwnError extends DomainError {
  constructor() {
    super('SELLER_CANNOT_BUY_OWN', 'You cannot buy your own listing.', 400);
  }
}
export class CardNotOwnedError extends DomainError {
  constructor() {
    super('CARD_NOT_OWNED', 'You do not own that card.', 404);
  }
}
export class InvalidPriceError extends DomainError {
  constructor() {
    super('INVALID_PRICE', 'Listing price must be a positive amount in cents.', 400);
  }
}
export class AuctionNotFoundError extends DomainError {
  constructor() {
    super('AUCTION_NOT_FOUND', 'Auction not found.', 404);
  }
}
export class NotAuctionOwnerError extends DomainError {
  constructor() {
    super('NOT_AUCTION_OWNER', 'Only the seller can perform that action.', 403);
  }
}
export class AuctionHasBidsError extends DomainError {
  constructor() {
    super('AUCTION_HAS_BIDS', 'Auctions with bids cannot be cancelled.', 409);
  }
}
export class BidTooHighError extends DomainError {
  constructor() {
    super('BID_TOO_HIGH', 'Bid exceeds the fat-finger guard (100× current bid).', 409);
  }
}
export class InvalidAuctionDurationError extends DomainError {
  constructor() {
    super('INVALID_AUCTION_DURATION', 'Auction duration must be 5 minutes, 30 minutes, or 2 hours.', 400);
  }
}
export class InvalidStartingBidError extends DomainError {
  constructor() {
    super('INVALID_STARTING_BID', 'Starting bid must be a positive amount in cents.', 400);
  }
}
