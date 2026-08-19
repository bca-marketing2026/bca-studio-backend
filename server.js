var token = localStorage.getItem("bca_token");
var toDelete = ["marca4531886","marca5121010","marca5228513","marca5612079","marca5755017","marca5770409","marca5932876","marca6092012","marca6479787","lekurestaurant","bca"];
toDelete.forEach(function(id){
  fetch("https://bca-studio-backend-production.up.railway.app/api/brands/"+id,{
    method:"DELETE",headers:{"Authorization":"Bearer "+token}
  }).then(r=>r.json()).then(d=>console.log("Deleted",id,d));
});
