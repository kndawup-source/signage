'use strict';
// 구버전 업로드 경로. 현재 화면은 /api/r2-presign 만 사용한다.
// 권한·용량 제한(병원 350MB / 슈퍼어드민 2GB)·키 형식·Content-Length 서명을 한 곳에서 관리하도록 그대로 위임한다.
module.exports = require('./r2-presign');
