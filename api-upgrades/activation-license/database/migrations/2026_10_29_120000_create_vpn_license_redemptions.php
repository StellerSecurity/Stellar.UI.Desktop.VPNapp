<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
return new class extends Migration {
    public function up(): void {
        Schema::create('vpn_license_redemptions', function (Blueprint $table) {
            $table->engine = 'InnoDB';
            $table->uuid('id')->primary();
            // Unique license ownership survives lost responses and process restarts.
            $table->string('license_id', 128)->unique();
            $table->string('account_id', 32);
            $table->string('subscription_id', 128);
            $table->unsignedInteger('days');
            $table->timestamp('created_at');
        });
    }
    public function down(): void {
        // Deliberately irreversible: deleting receipts could permit credit replay.
        throw new LogicException('Redemption history must be retained.');
    }
};
