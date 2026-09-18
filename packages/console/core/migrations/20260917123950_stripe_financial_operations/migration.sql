CREATE TABLE `stripe_operation` (
	`operation_id` varchar(255) PRIMARY KEY,
	`claim_id` varchar(36) NOT NULL,
	`time_created` timestamp(3) NOT NULL DEFAULT (now())
);
--> statement-breakpoint
ALTER TABLE `payment` ADD `refunded_amount` bigint;