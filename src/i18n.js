import messages from './locales/messages.json' with {type:'json'};

export const localeFor=language=>language==='vi'?'vi-VN':'en-US';
export function tr(key,language='en',params={}){
  const template=messages[key]?.[language]??messages[key]?.en??key;
  return template.replace(/\{(\w+)\}/g,(_,name)=>String(params[name]??''));
}
const errors={
  'Kho đang bận; thử lại sau.':'The archive is busy. Please try again.',
  'Yêu cầu không hợp lệ.':'Invalid request.',
  'Chỉ dùng trong extension.':'This action is only available inside the extension.',
  'Cài đặt không hợp lệ.':'Invalid settings.',
  'Yêu cầu không được hỗ trợ.':'This action is not supported.',
  'Yêu cầu phương tiện không hợp lệ.':'Invalid media request.',
  'Bản lưu phương tiện không còn trong kho.':'This media file is no longer in the archive.',
  'Mã tin không hợp lệ.':'Invalid message ID.',
  'Yêu cầu dọn tệp không hợp lệ.':'Invalid cleanup request.',
  'Dữ liệu phương tiện không hợp lệ.':'Invalid media data.',
  'Không nhận được phản hồi từ kho tin nhắn.':'No response from the message archive.',
  'Tệp phương tiện không tải được hoặc vượt 8 MiB.':'The media could not be downloaded or exceeds 8 MiB.',
  'Phương tiện không có nội dung.':'The media file has no content.',
  'Tệp phương tiện vượt 8 MiB.':'The media file exceeds 8 MiB.',
  'Chỉ hỗ trợ ảnh và tin nhắn thoại.':'Only photos and voice notes are supported.',
};
export function localizeError(value,language='en'){
  const message=String(value||'');
  if(language==='vi')return message;
  if(errors[message])return errors[message];
  const source=message.match(/^Không xác thực được nguồn gửi \(([^)]+)\)\.$/);
  return source?`The request source could not be verified (${source[1]}).`:message;
}
