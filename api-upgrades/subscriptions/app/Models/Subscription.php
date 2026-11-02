<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

class Subscription extends Model
{

    use HasUuids;
    use SoftDeletes;

    protected $table = "subscriptions";

    protected $fillable = [
        'user_id',
        'type',
        'expires_at',
        'status',
        'source',
        'source_meta',
        'reseller_user_id',
        'id',
        'plan_id',
        'activated_at',
        'meta',
    ];

    protected $casts = [
        'expires_at'   => 'datetime',
        'activated_at' => 'datetime',
        'deleted_at'   => 'datetime',
        'created_at'   => 'datetime',
        'updated_at'   => 'datetime',
        'meta'         => 'array',
        'source_meta'  => 'array',
    ];

    public function events(): HasMany
    {
        return $this->hasMany(SubscriptionEvent::class, 'subscription_id', 'id');
    }

}

