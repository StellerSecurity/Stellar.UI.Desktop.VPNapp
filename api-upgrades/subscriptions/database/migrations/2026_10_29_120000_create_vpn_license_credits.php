<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
return new class extends Migration {
    public function up(): void {
        Schema::create('vpn_license_credits', function (Blueprint $table) {
            $table->engine = 'InnoDB';
            $table->uuid('receipt_id')->primary();
            $table->string('account_id', 32);
            $table->string('subscription_id', 128)->index();
            $table->unsignedInteger('days');
            $table->timestamp('created_at');
        });
    }
    public function down(): void { throw new LogicException('Redemption history must be retained.'); }
};
