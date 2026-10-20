//! 口令哈希、JWT 令牌签发与校验。

use crate::config::ResolvedConfig;
use crate::error::{AppError, AppResult};
use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

/// 角色。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Admin,
    Teacher,
}

impl Role {
    pub fn parse(value: &str) -> AppResult<Self> {
        match value {
            "admin" => Ok(Role::Admin),
            "teacher" => Ok(Role::Teacher),
            other => Err(AppError::Internal(format!("未知角色：{other}"))),
        }
    }
}

/// JWT 载荷。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    /// 用户 ID
    pub sub: i64,
    /// 用户名
    pub username: String,
    /// 角色
    pub role: Role,
    /// 过期时间（Unix 秒）
    pub exp: i64,
    /// 签发时间（Unix 秒）
    pub iat: i64,
}

/// 使用 Argon2id 计算口令哈希。
pub fn hash_password(plain: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(plain.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("口令哈希失败：{e}"))?;
    Ok(hash.to_string())
}

/// 校验口令是否匹配哈希。
pub fn verify_password(plain: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(plain.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// 为指定用户签发令牌。
pub fn issue_token(config: &ResolvedConfig, user_id: i64, username: &str, role: Role) -> AppResult<String> {
    let now = Utc::now();
    let claims = Claims {
        sub: user_id,
        username: username.to_string(),
        role,
        iat: now.timestamp(),
        exp: (now + Duration::hours(config.raw.auth.token_ttl_hours)).timestamp(),
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(config.raw.auth.jwt_secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(format!("令牌签发失败：{e}")))
}

/// 校验并解析令牌。
pub fn verify_token(config: &ResolvedConfig, token: &str) -> AppResult<Claims> {
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(config.raw.auth.jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|_| AppError::Unauthorized)?;

    Ok(data.claims)
}
